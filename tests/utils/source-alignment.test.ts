import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

const mockCreateSourceAlignment = jest.fn<any>();

let runSourceAlignment: any;
let reportSourceAlignment: any;
let SourceAlignmentRequestError: any;

beforeAll(async () => {
  const actualApi: any = await import('../../src/api/source-alignments.js');
  SourceAlignmentRequestError = actualApi.SourceAlignmentRequestError;
  await jest.unstable_mockModule('../../src/api/source-alignments.js', () => ({
    ...actualApi,
    createSourceAlignment: mockCreateSourceAlignment
  }));
  const module = await import('../../src/utils/source-alignment.js');
  runSourceAlignment = module.runSourceAlignment;
  reportSourceAlignment = module.reportSourceAlignment;
});

const config = { projectId: 'proj', sourceLocale: 'en', outputLocales: ['fr', 'de'] } as any;
const request = { projectId: 'proj', branch: 'feature/reword', jobGroupId: 'grp-1', headSha: 'abc123' };

function candidate(key: string, locale = 'fr', overrides: Record<string, unknown> = {}) {
  return {
    locale,
    source_path: 'config/locales/en.yml',
    target_path: `config/locales/${locale}.yml`,
    format: 'yml',
    key,
    previous_source: 'Profile!',
    source: 'Your profile',
    target_base: 'Profil !',
    target_current: 'Profil !',
    ...overrides
  };
}

function resultItem(c: any, status: string, extra: Record<string, unknown> = {}) {
  return { source_path: c.source_path, target_path: c.target_path, key: c.key, status, ...extra };
}

function enabledResponse(items: unknown[], notices: string[] = []) {
  return { enabled: true, job_group: { id: 'grp-1', short_url: 'https://localhero.ai/r/grp' }, items, notices };
}

function echoResponse(status: string, extra: Record<string, unknown> = {}) {
  return async (params: any) => enabledResponse(params.items.map((item: any) => resultItem(item, status, extra)));
}

describe('runSourceAlignment', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock; warn: jest.Mock };
  let updateTranslationFile: jest.Mock<any>;
  let deps: any;

  beforeEach(() => {
    mockCreateSourceAlignment.mockReset();
    mockConsole = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    updateTranslationFile = jest.fn<any>().mockResolvedValue({ updatedKeys: [], created: false });
    deps = { console: mockConsole, updateTranslationFile, config };
  });

  function logged(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('asks one locale at a time in chunks of 25', async () => {
    const candidates = [
      ...Array.from({ length: 26 }, (_, i) => candidate(`key_${i}`, 'fr')),
      candidate('key_0', 'de')
    ];
    mockCreateSourceAlignment.mockImplementation(echoResponse('unchanged'));

    await runSourceAlignment(candidates, request, deps);

    const calls = mockCreateSourceAlignment.mock.calls.map((call: any) => [call[0].locale, call[0].items.length]);
    expect(calls).toEqual([['fr', 25], ['fr', 1], ['de', 1]]);
    expect(mockCreateSourceAlignment.mock.calls[0][0]).toMatchObject({
      projectId: 'proj',
      branch: 'feature/reword',
      jobGroupId: 'grp-1',
      headSha: 'abc123'
    });
    expect(mockCreateSourceAlignment.mock.calls[0][0].items[0]).toEqual({
      source_path: 'config/locales/en.yml',
      target_path: 'config/locales/fr.yml',
      format: 'yml',
      key: 'key_0',
      previous_source: 'Profile!',
      source: 'Your profile',
      target_base: 'Profil !',
      target_current: 'Profil !'
    });
  });

  it('writes aligned values into their target files, grouped per file', async () => {
    mockCreateSourceAlignment.mockImplementation(async (params: any) => enabledResponse(
      params.items.map((item: any) => resultItem(item, 'aligned', { value: `${params.locale}:${item.key}` }))
    ));

    const result = await runSourceAlignment(
      [candidate('profile.title', 'fr'), candidate('profile.hint', 'fr'), candidate('profile.title', 'de')],
      request,
      deps
    );

    expect(updateTranslationFile).toHaveBeenCalledTimes(2);
    expect(updateTranslationFile).toHaveBeenCalledWith(
      'config/locales/fr.yml',
      { 'profile.title': 'fr:profile.title', 'profile.hint': 'fr:profile.hint' },
      'fr',
      'config/locales/en.yml',
      undefined,
      config
    );
    expect(result.alignedCells.map((cell: any) => [cell.locale, cell.key, cell.value])).toEqual([
      ['fr', 'profile.title', 'fr:profile.title'],
      ['fr', 'profile.hint', 'fr:profile.hint'],
      ['de', 'profile.title', 'de:profile.title']
    ]);
    expect(result.enabled).toBe(true);
  });

  it('writes a multi-language file under the target locale', async () => {
    const viewPath = 'app/views/profile/show.i18n.yml';
    mockCreateSourceAlignment.mockImplementation(echoResponse('aligned', { value: 'Votre profil' }));

    await runSourceAlignment(
      [candidate('title', 'fr', { source_path: viewPath, target_path: viewPath })],
      request,
      deps
    );

    expect(updateTranslationFile).toHaveBeenCalledWith(viewPath, { title: 'Votre profil' }, 'fr', viewPath, undefined, config);
  });

  it('writes nothing for unchanged and skipped items and counts them per locale', async () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c')];
    mockCreateSourceAlignment.mockResolvedValue(enabledResponse([
      resultItem(candidates[0], 'unchanged'),
      resultItem(candidates[1], 'skipped', { reason: 'edited_in_pr' }),
      resultItem(candidates[2], 'skipped', { reason: 'edited_in_pr' })
    ]));

    const result = await runSourceAlignment(candidates, request, deps);

    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.alignedCells).toEqual([]);
    expect(result.localeSummaries).toEqual({ fr: { aligned: 0, unchanged: 1, skipped: { edited_in_pr: 2 } } });
  });

  it('stops without writing when the feature is off', async () => {
    mockCreateSourceAlignment.mockResolvedValue({ enabled: false, items: [], notices: [] });

    const result = await runSourceAlignment([candidate('a', 'fr'), candidate('a', 'de')], request, deps);

    expect(mockCreateSourceAlignment).toHaveBeenCalledTimes(1);
    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(logged()).toBe('');
  });

  it('stops silently on a 404 from a backend without the endpoint', async () => {
    mockCreateSourceAlignment.mockRejectedValue(new SourceAlignmentRequestError('Not found', 404));

    const result = await runSourceAlignment([candidate('a', 'fr'), candidate('a', 'de')], request, deps);

    expect(mockCreateSourceAlignment).toHaveBeenCalledTimes(1);
    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(logged()).toBe('');
  });

  it('prints the message of a 422 and moves on to the next locale', async () => {
    mockCreateSourceAlignment
      .mockRejectedValueOnce(new SourceAlignmentRequestError('Unknown locale fr', 422))
      .mockImplementationOnce(echoResponse('aligned', { value: 'Dein Profil' }));

    const result = await runSourceAlignment([candidate('a', 'fr'), candidate('a', 'de')], request, deps);

    expect(logged()).toContain('Unknown locale fr');
    expect(updateTranslationFile).toHaveBeenCalledTimes(1);
    expect(updateTranslationFile.mock.calls[0][2]).toBe('de');
    expect(result.alignedCells.map((cell: any) => cell.locale)).toEqual(['de']);
  });

  it.each([
    ['a server error', () => new SourceAlignmentRequestError('Something went wrong', 500)],
    ['a network error', () => new TypeError('fetch failed')]
  ])('warns on %s and moves on to the next locale', async (_label, buildError) => {
    mockCreateSourceAlignment
      .mockRejectedValueOnce(buildError())
      .mockImplementationOnce(echoResponse('unchanged'));

    const result = await runSourceAlignment([candidate('a', 'fr'), candidate('a', 'de')], request, deps);

    expect(logged()).toMatch(/Could not align fr translations/);
    expect(mockCreateSourceAlignment).toHaveBeenCalledTimes(2);
    expect(result.localeSummaries.de).toEqual({ aligned: 0, unchanged: 1, skipped: {} });
  });

  it('writes nothing for a locale when a later chunk fails', async () => {
    const candidates = Array.from({ length: 26 }, (_, i) => candidate(`key_${i}`, 'fr'));
    mockCreateSourceAlignment
      .mockImplementationOnce(echoResponse('aligned', { value: 'x' }))
      .mockRejectedValueOnce(new SourceAlignmentRequestError('Something went wrong', 503));

    const result = await runSourceAlignment(candidates, request, deps);

    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.alignedCells).toEqual([]);
  });

  it('writes nothing for a locale when the response does not match the request', async () => {
    mockCreateSourceAlignment.mockResolvedValue(enabledResponse([
      resultItem(candidate('other'), 'aligned', { value: 'x' })
    ]));

    const result = await runSourceAlignment([candidate('a')], request, deps);

    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.alignedCells).toEqual([]);
    expect(logged()).toMatch(/Could not align fr translations/);
  });

  it('writes nothing for a locale when a returned item names another source file', async () => {
    const requested = candidate('a');
    mockCreateSourceAlignment.mockResolvedValue(enabledResponse([
      { ...resultItem(requested, 'aligned', { value: 'x' }), source_path: 'config/locales/other.en.yml' }
    ]));

    const result = await runSourceAlignment([requested], request, deps);

    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.alignedCells).toEqual([]);
  });

  it('collects notices once and the job group link', async () => {
    mockCreateSourceAlignment.mockImplementation(async (params: any) => ({
      ...enabledResponse(params.items.map((item: any) => resultItem(item, 'unchanged')), ['Credits are running low']),
      job_group: { id: 'grp-1', short_url: 'https://localhero.ai/r/grp' }
    }));

    const result = await runSourceAlignment([candidate('a', 'fr'), candidate('a', 'de')], request, deps);

    expect(result.notices).toEqual(['Credits are running low']);
    expect(result.shortUrl).toBe('https://localhero.ai/r/grp');
  });
});

describe('reportSourceAlignment', () => {
  it('prints aligned, already fitting and skipped counts per locale, then the notices', () => {
    const log = jest.fn();

    reportSourceAlignment({
      enabled: true,
      alignedCells: [],
      localeSummaries: {
        fr: { aligned: 2, unchanged: 1, skipped: { edited_in_pr: 2, trivial_edit: 1 } },
        de: { aligned: 1, unchanged: 0, skipped: {} }
      },
      notices: ['Credits are running low'],
      shortUrl: null
    }, { log });

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('fr: 2 aligned, 1 already fits, 3 skipped (2 edited_in_pr, 1 trivial_edit)');
    expect(output).toContain('de: 1 aligned');
    expect(output).toContain('Credits are running low');
  });

  it('prints nothing when the backend did not align', () => {
    const log = jest.fn();

    reportSourceAlignment({ enabled: false, alignedCells: [], localeSummaries: {}, notices: [], shortUrl: null }, { log });

    expect(log).not.toHaveBeenCalled();
  });
});
