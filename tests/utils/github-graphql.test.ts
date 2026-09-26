import { describe, it, expect, jest } from '@jest/globals';
import {
  createSignedCommit,
  fetchBranchHead,
  fetchChangedPaths,
  StaleHeadError,
  GitHubGraphQLError
} from '../../src/utils/github-graphql.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('createSignedCommit', () => {
  it('sends a POST to the graphql endpoint with the expected variables', async () => {
    const mockFetch = jest.fn(async () =>
      jsonResponse({
        data: {
          createCommitOnBranch: {
            commit: { oid: 'c'.repeat(40), url: 'https://github.com/o/r/commit/cccc' }
          }
        }
      })
    );

    const result = await createSignedCommit(
      {
        repositoryNameWithOwner: 'localheroai/test',
        branchName: 'feature',
        expectedHeadOid: 'a'.repeat(40),
        message: { headline: 'Sync translations', body: '5 keys in sv' },
        fileChanges: { additions: [{ path: 'sv.yml', contents: 'aGVsbG8=' }] },
        token: 'ghs_token'
      },
      { fetch: mockFetch as any }
    );

    expect(result.commitSha).toBe('c'.repeat(40));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_token');

    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('createCommitOnBranch');
    expect(body.variables.input.branch.repositoryNameWithOwner).toBe('localheroai/test');
    expect(body.variables.input.branch.branchName).toBe('feature');
    expect(body.variables.input.expectedHeadOid).toBe('a'.repeat(40));
    expect(body.variables.input.message).toEqual({ headline: 'Sync translations', body: '5 keys in sv' });
    expect(body.variables.input.fileChanges.additions).toEqual([{ path: 'sv.yml', contents: 'aGVsbG8=' }]);
  });

  it('throws StaleHeadError when GitHub returns STALE_DATA', async () => {
    const mockFetch = jest.fn(async () =>
      jsonResponse({
        errors: [{ type: 'STALE_DATA', message: 'Expected branch to point to "abc" but it did not. Pull and try again.' }]
      })
    );

    await expect(
      createSignedCommit(
        {
          repositoryNameWithOwner: 'localheroai/test',
          branchName: 'feature',
          expectedHeadOid: 'a'.repeat(40),
          message: { headline: 'msg' },
          fileChanges: { additions: [{ path: 'a', contents: 'YQ==' }] },
          token: 'ghs_token'
        },
        { fetch: mockFetch as any }
      )
    ).rejects.toBeInstanceOf(StaleHeadError);
  });

  it('throws StaleHeadError when STALE_DATA appears alongside other errors', async () => {
    const mockFetch = jest.fn(async () =>
      jsonResponse({
        errors: [
          { type: 'OTHER', message: 'noise that came back first' },
          { type: 'STALE_DATA', message: 'Expected branch to point to "abc" but it did not. Pull and try again.' }
        ]
      })
    );

    await expect(
      createSignedCommit(
        {
          repositoryNameWithOwner: 'localheroai/test',
          branchName: 'feature',
          expectedHeadOid: 'a'.repeat(40),
          message: { headline: 'msg' },
          fileChanges: {},
          token: 'ghs_token'
        },
        { fetch: mockFetch as any }
      )
    ).rejects.toBeInstanceOf(StaleHeadError);
  });

  it('throws GitHubGraphQLError on rule violation errors', async () => {
    const mockFetch = jest.fn(async () =>
      jsonResponse({
        errors: [{ type: 'UNPROCESSABLE', message: '5 of 5 changes must be made through a pull request' }]
      })
    );

    await expect(
      createSignedCommit(
        {
          repositoryNameWithOwner: 'localheroai/test',
          branchName: 'feature',
          expectedHeadOid: 'a'.repeat(40),
          message: { headline: 'msg' },
          fileChanges: { additions: [{ path: 'a', contents: 'YQ==' }] },
          token: 'ghs_token'
        },
        { fetch: mockFetch as any }
      )
    ).rejects.toMatchObject({
      name: 'GitHubGraphQLError',
      message: expect.stringContaining('pull request')
    });
  });

  it('throws GitHubGraphQLError on non-2xx HTTP response', async () => {
    const mockFetch = jest.fn(async () =>
      new Response('Unauthorized', { status: 401 })
    );

    await expect(
      createSignedCommit(
        {
          repositoryNameWithOwner: 'localheroai/test',
          branchName: 'feature',
          expectedHeadOid: 'a'.repeat(40),
          message: { headline: 'msg' },
          fileChanges: {},
          token: 'bad'
        },
        { fetch: mockFetch as any }
      )
    ).rejects.toBeInstanceOf(GitHubGraphQLError);
  });
});

describe('fetchBranchHead', () => {
  it('returns the sha the branch ref points to', async () => {
    const mockFetch = jest.fn(async () => jsonResponse({ object: { sha: 'd'.repeat(40) } }));

    const sha = await fetchBranchHead('localheroai/test', 'feature/login', 'ghs_token', { fetch: mockFetch as any });

    expect(sha).toBe('d'.repeat(40));
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/localheroai/test/git/ref/heads/feature/login');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_token');
  });

  it('throws when the ref cannot be read', async () => {
    const mockFetch = jest.fn(async () => new Response('Not Found', { status: 404 }));

    await expect(fetchBranchHead('localheroai/test', 'gone', 'ghs_token', { fetch: mockFetch as any }))
      .rejects.toBeInstanceOf(GitHubGraphQLError);
  });
});

describe('fetchChangedPaths', () => {
  const BASE = 'a'.repeat(40);
  const HEAD = 'd'.repeat(40);

  function compareResponse(overrides: Record<string, unknown> = {}) {
    return {
      status: 'ahead',
      total_commits: 1,
      commits: [{ sha: HEAD }],
      files: [{ filename: 'app/models/user.rb', status: 'modified' }],
      ...overrides
    };
  }

  async function changedPaths(body: unknown) {
    const mockFetch = jest.fn(async () => jsonResponse(body));
    const paths = await fetchChangedPaths('localheroai/test', BASE, HEAD, 'ghs_token', { fetch: mockFetch as any });
    return { paths, mockFetch };
  }

  it('compares base...head and returns the changed paths', async () => {
    const { paths, mockFetch } = await changedPaths(compareResponse({
      files: [
        { filename: 'app/models/user.rb', status: 'modified' },
        { filename: 'config/locales/en.yml', status: 'added' }
      ]
    }));

    expect(paths).toEqual(['app/models/user.rb', 'config/locales/en.yml']);
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://api.github.com/repos/localheroai/test/compare/${BASE}...${HEAD}`);
  });

  it('returns both sides of a rename', async () => {
    const { paths } = await changedPaths(compareResponse({
      files: [{ filename: 'config/locales/sv-SE.yml', previous_filename: 'config/locales/sv.yml', status: 'renamed' }]
    }));

    expect(paths).toEqual(['config/locales/sv-SE.yml', 'config/locales/sv.yml']);
  });

  it.each(['diverged', 'behind', 'identical'])('returns null when the head is %s', async status => {
    const { paths } = await changedPaths(compareResponse({ status }));

    expect(paths).toBeNull();
  });

  it('returns null when the files list hits the 300-file cap', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/file${i}.ts`, status: 'modified' }));

    const { paths } = await changedPaths(compareResponse({ files }));

    expect(paths).toBeNull();
  });

  it('returns null when the commits list is cut short', async () => {
    const { paths } = await changedPaths(compareResponse({ total_commits: 251, commits: Array(250).fill({ sha: HEAD }) }));

    expect(paths).toBeNull();
  });

  it('returns null when the files list is missing', async () => {
    const { paths } = await changedPaths(compareResponse({ files: undefined }));

    expect(paths).toBeNull();
  });

  it('throws when the compare request fails', async () => {
    const mockFetch = jest.fn(async () => new Response('Not Found', { status: 404 }));

    await expect(fetchChangedPaths('localheroai/test', BASE, HEAD, 'ghs_token', { fetch: mockFetch as any }))
      .rejects.toBeInstanceOf(GitHubGraphQLError);
  });
});
