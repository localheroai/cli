import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

let createTargetEditAlignment: any;
let TargetEditAlignmentRequestError: any;
const mockFetch = jest.fn<any>();

beforeAll(async () => {
  await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
    getApiKey: async () => 'tk_test'
  }));
  const module = await import('../../src/api/target-edit-alignments.js');
  createTargetEditAlignment = module.createTargetEditAlignment;
  TargetEditAlignmentRequestError = module.TargetEditAlignmentRequestError;
});

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  process.env.LOCALHERO_API_HOST = 'https://api.example.test';
});

const item = {
  source_path: 'config/locales/profile.i18n.yml',
  format: 'yml',
  key: 'profile.published',
  source_base: 'Your profile is published',
  source: 'Your profile is published',
  targets: [
    {
      locale: 'sv',
      target_path: 'config/locales/profile.i18n.yml',
      base: 'Din profil är publicerad',
      current: 'Din profil är publicerad nu'
    }
  ]
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('createTargetEditAlignment', () => {
  it('posts the items and returns the parsed response', async () => {
    const body = {
      enabled: true,
      items: [{
        source_path: item.source_path,
        key: item.key,
        status: 'updated',
        trigger_locale: 'sv',
        trigger_value: 'Din profil är publicerad nu',
        source: 'Your profile is published now',
        align_locales: ['nb'],
        trigger_at_base: false
      }]
    };
    mockFetch.mockResolvedValue(jsonResponse(200, body));

    const result = await createTargetEditAlignment({
      projectId: 'proj',
      branch: 'feature/now',
      jobGroupId: 'grp',
      headSha: 'abc123',
      items: [item]
    });

    expect(result).toEqual(body);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/projects/proj/target_edit_alignments');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tk_test');
    expect(JSON.parse(init.body)).toEqual({
      branch: 'feature/now',
      job_group_id: 'grp',
      head_sha: 'abc123',
      items: [item]
    });
  });

  it('omits head_sha when unknown', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { enabled: false, items: [] }));

    await createTargetEditAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', items: [item] });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('head_sha');
  });

  it('throws the status and the backend message on an error response', async () => {
    mockFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'invalid_parameters', message: 'Duplicate locale sv' } }));

    const error = await createTargetEditAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', items: [item] })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TargetEditAlignmentRequestError);
    expect(error.status).toBe(422);
    expect(error.message).toBe('Duplicate locale sv');
  });

  it('falls back to the status when the error body is not JSON', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => '<html>Not found</html>' });

    const error = await createTargetEditAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', items: [item] })
      .catch((err: unknown) => err);

    expect(error.status).toBe(404);
    expect(error.message).toContain('404');
  });

  it('rejects a success response without an items list', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>ok</html>' });

    await expect(
      createTargetEditAlignment({ projectId: 'proj', branch: 'b', jobGroupId: 'grp', items: [item] })
    ).rejects.toBeInstanceOf(TargetEditAlignmentRequestError);
  });
});
