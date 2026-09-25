import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

const mockCreatePullRequestImport = jest.fn<any>();

let sendAlignedImport: any;
let PullRequestImportError: any;

beforeAll(async () => {
  const actualApi: any = await import('../../src/api/pull-request-imports.js');
  PullRequestImportError = actualApi.PullRequestImportError;
  await jest.unstable_mockModule('../../src/api/pull-request-imports.js', () => ({
    ...actualApi,
    createPullRequestImport: mockCreatePullRequestImport
  }));
  sendAlignedImport = (await import('../../src/utils/aligned-import.js')).sendAlignedImport;
});

const request = { projectId: 'proj', branch: 'feature/reword', jobGroupId: 'grp-1' };

function cell(key: string, locale = 'fr', targetPath = `config/locales/${locale}.yml`) {
  return {
    locale,
    source_path: 'config/locales/en.yml',
    target_path: targetPath,
    format: 'yml',
    key,
    previous_source: 'Profile!',
    source: 'Your profile',
    target_base: 'Profil !',
    target_current: 'Profil !',
    value: 'Votre profil'
  };
}

describe('sendAlignedImport', () => {
  let log: jest.Mock;
  let sleep: jest.Mock<any>;

  beforeEach(() => {
    mockCreatePullRequestImport.mockReset();
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [] });
    log = jest.fn();
    sleep = jest.fn<any>().mockResolvedValue(undefined);
  });

  function logged(): string {
    return log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('sends each aligned cell as an update carrying the source it was aligned to', async () => {
    await sendAlignedImport([cell('profile.title'), cell('profile.hint'), cell('profile.title', 'de')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestImport.mock.calls[0][0]).toEqual({
      projectId: 'proj',
      branch: 'feature/reword',
      jobGroupId: 'grp-1',
      files: [
        {
          path: 'config/locales/fr.yml',
          source_path: 'config/locales/en.yml',
          locale: 'fr',
          format: 'yml',
          changes: [
            { key: 'profile.title', status: 'updated', value: 'Votre profil', old_value: 'Profil !', source_value: 'Your profile', aligned_source: 'Your profile' },
            { key: 'profile.hint', status: 'updated', value: 'Votre profil', old_value: 'Profil !', source_value: 'Your profile', aligned_source: 'Your profile' }
          ]
        },
        {
          path: 'config/locales/de.yml',
          source_path: 'config/locales/en.yml',
          locale: 'de',
          format: 'yml',
          changes: [
            { key: 'profile.title', status: 'updated', value: 'Votre profil', old_value: 'Profil !', source_value: 'Your profile', aligned_source: 'Your profile' }
          ]
        }
      ]
    });
  });

  it('keeps the locales of a multi-language file apart', async () => {
    const viewPath = 'app/views/profile/show.i18n.yml';

    await sendAlignedImport([cell('title', 'fr', viewPath), cell('title', 'de', viewPath)], request, { console: { log }, sleep });

    const files = mockCreatePullRequestImport.mock.calls[0][0].files;
    expect(files.map((file: any) => [file.path, file.locale])).toEqual([[viewPath, 'fr'], [viewPath, 'de']]);
  });

  it('splits requests at 50 files', async () => {
    const cells = Array.from({ length: 51 }, (_, i) => cell('title', 'fr', `config/locales/file_${i}.fr.yml`));

    await sendAlignedImport(cells, request, { console: { log }, sleep });

    const fileCounts = mockCreatePullRequestImport.mock.calls.map((call: any) => call[0].files.length);
    expect(fileCounts).toEqual([50, 1]);
  });

  it('splits requests at 1,000 changes, also inside one file', async () => {
    const cells = Array.from({ length: 1001 }, (_, i) => cell(`key_${i}`));

    await sendAlignedImport(cells, request, { console: { log }, sleep });

    const changeCounts = mockCreatePullRequestImport.mock.calls.map((call: any) =>
      call[0].files.reduce((sum: number, file: any) => sum + file.changes.length, 0)
    );
    expect(changeCounts).toEqual([1000, 1]);
  });

  it('retries a failed request', async () => {
    mockCreatePullRequestImport
      .mockRejectedValueOnce(new PullRequestImportError('Translation ingestion failed with status 502', 502))
      .mockResolvedValueOnce({ imported_count: 1, skipped: [] });

    await sendAlignedImport([cell('title')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(2);
    expect(logged()).not.toContain('Could not');
  });

  it('does not retry a rejected request', async () => {
    mockCreatePullRequestImport.mockRejectedValue(
      new PullRequestImportError('Translation ingestion failed with status 422', 422)
    );

    await sendAlignedImport([cell('title')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logged()).toContain('status 422');
  });

  it.each([
    ['a programming error', () => new Error('boom')],
    ['an unreadable response', () => new SyntaxError('Unexpected token < in JSON')]
  ])('does not retry %s', async (_label, buildError) => {
    mockCreatePullRequestImport.mockRejectedValue(buildError());

    await sendAlignedImport([cell('title')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    mockCreatePullRequestImport
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ imported_count: 1, skipped: [] });

    await sendAlignedImport([cell('title')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(2);
  });

  it('sends old_value as null when the target had no base value', async () => {
    await sendAlignedImport([{ ...cell('title'), target_base: null }], request, { console: { log }, sleep });

    const change = mockCreatePullRequestImport.mock.calls[0][0].files[0].changes[0];
    expect(change).toHaveProperty('old_value', null);
  });

  it('retries a network error', async () => {
    mockCreatePullRequestImport
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ imported_count: 1, skipped: [] });

    await sendAlignedImport([cell('title')], request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(2);
  });

  it('warns after the retries run out and still sends the next chunk', async () => {
    const cells = Array.from({ length: 51 }, (_, i) => cell('title', 'fr', `config/locales/file_${i}.fr.yml`));
    mockCreatePullRequestImport.mockImplementation(async (params: any) => {
      if (params.files.length === 50) throw new PullRequestImportError('Translation ingestion failed with status 500', 500);
      return { imported_count: 1, skipped: [] };
    });

    await sendAlignedImport(cells, request, { console: { log }, sleep });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(logged()).toContain('Could not send 50 aligned values to Localhero');
    expect(logged()).toContain('status 500');
  });
});
