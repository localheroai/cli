import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

let createSourceAlignment: any;
let SourceAlignmentRequestError: any;
const mockFetch = jest.fn<any>();

beforeAll(async () => {
  await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
    getApiKey: async () => 'tk_test'
  }));
  const module = await import('../../src/api/source-alignments.js');
  createSourceAlignment = module.createSourceAlignment;
  SourceAlignmentRequestError = module.SourceAlignmentRequestError;
});

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  process.env.LOCALHERO_API_HOST = 'https://api.example.test';
});

const item = {
  source_path: 'config/locales/en.yml',
  target_path: 'config/locales/fr.yml',
  format: 'yml',
  key: 'profile.title',
  previous_source: 'Profile!',
  source: 'Your profile',
  target_base: 'Profil !',
  target_current: 'Profil !'
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('createSourceAlignment', () => {
  it('posts one locale with its items and returns the parsed response', async () => {
    const body = { enabled: true, job_group: { id: 'grp', short_url: 'https://x/r/1' }, items: [], notices: [] };
    mockFetch.mockResolvedValue(jsonResponse(200, body));

    const result = await createSourceAlignment({
      projectId: 'proj',
      branch: 'feature/reword',
      jobGroupId: 'grp',
      headSha: 'abc123',
      locale: 'fr',
      items: [item]
    });

    expect(result).toEqual(body);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/projects/proj/source_alignments');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tk_test');
    expect(JSON.parse(init.body)).toEqual({
      branch: 'feature/reword',
      job_group_id: 'grp',
      head_sha: 'abc123',
      locale: 'fr',
      items: [item]
    });
  });

  it('omits head_sha when unknown', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { enabled: false, items: [], notices: [] }));

    await createSourceAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', locale: 'fr', items: [item] });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('head_sha');
  });

  it('throws the status and the backend message on an error response', async () => {
    mockFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'invalid_parameters', message: 'Unknown locale xx' } }));

    const error = await createSourceAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', locale: 'xx', items: [item] })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SourceAlignmentRequestError);
    expect(error.status).toBe(422);
    expect(error.message).toBe('Unknown locale xx');
  });

  it('falls back to the status when the error body is not JSON', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' });

    const error = await createSourceAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', locale: 'fr', items: [item] })
      .catch((err: unknown) => err);

    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });

  it('rejects a success response without an items list', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>ok</html>' });

    await expect(
      createSourceAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', locale: 'fr', items: [item] })
    ).rejects.toBeInstanceOf(SourceAlignmentRequestError);
  });
});
