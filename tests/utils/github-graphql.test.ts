import { describe, it, expect, jest } from '@jest/globals';
import {
  createSignedCommit,
  fetchBranchHead,
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
        errors: [{ type: 'STALE_DATA', message: 'Expected branch to point at <abc> but it points at <def>' }]
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
          { type: 'STALE_DATA', message: 'Expected branch to point at <abc> but it points at <def>' }
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
  it('returns sha, parent sha, and author email', async () => {
    const mockFetch = jest.fn()
      .mockImplementationOnce(async () => jsonResponse({ object: { sha: 'a'.repeat(40) } }))
      .mockImplementationOnce(async () => jsonResponse({
        parents: [{ sha: 'b'.repeat(40) }],
        commit: { author: { email: 'developer@example.com' } }
      }));

    const head = await fetchBranchHead(
      'localheroai/test',
      'feature',
      'ghs_token',
      { fetch: mockFetch as any }
    );

    expect(head.sha).toBe('a'.repeat(40));
    expect(head.parentSha).toBe('b'.repeat(40));
    expect(head.authorEmail).toBe('developer@example.com');

    const [refUrl] = mockFetch.mock.calls[0] as [string];
    expect(refUrl).toBe('https://api.github.com/repos/localheroai/test/git/ref/heads/feature');
  });

  it('throws when ref response is not 200', async () => {
    const mockFetch = jest.fn(async () => new Response('Not Found', { status: 404 }));

    await expect(
      fetchBranchHead('localheroai/test', 'missing', 'ghs_token', { fetch: mockFetch as any })
    ).rejects.toBeInstanceOf(GitHubGraphQLError);
  });

  it('handles a commit with no parents (initial commit)', async () => {
    const mockFetch = jest.fn()
      .mockImplementationOnce(async () => jsonResponse({ object: { sha: 'a'.repeat(40) } }))
      .mockImplementationOnce(async () => jsonResponse({
        parents: [],
        commit: { author: { email: null } }
      }));

    const head = await fetchBranchHead(
      'localheroai/test',
      'feature',
      'ghs_token',
      { fetch: mockFetch as any }
    );

    expect(head.parentSha).toBeNull();
  });
});
