import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const mockCreateTargetEditAlignment = jest.fn<any>();

let runTargetEditAlignment: any;
let replaceAlignmentCandidates: any;
let withRevertedChanges: any;
let addSourceCells: any;
let refreshFileContent: any;
let reportTargetEditAlignment: any;
let TargetEditAlignmentRequestError: any;

beforeAll(async () => {
  const actualApi: any = await import('../../src/api/target-edit-alignments.js');
  TargetEditAlignmentRequestError = actualApi.TargetEditAlignmentRequestError;
  await jest.unstable_mockModule('../../src/api/target-edit-alignments.js', () => ({
    ...actualApi,
    createTargetEditAlignment: mockCreateTargetEditAlignment
  }));
  const module = await import('../../src/utils/target-edit-alignment.js');
  runTargetEditAlignment = module.runTargetEditAlignment;
  replaceAlignmentCandidates = module.replaceAlignmentCandidates;
  withRevertedChanges = module.withRevertedChanges;
  addSourceCells = module.addSourceCells;
  refreshFileContent = module.refreshFileContent;
  reportTargetEditAlignment = module.reportTargetEditAlignment;
});

const config = { projectId: 'proj', sourceLocale: 'en', outputLocales: ['sv', 'nb', 'fi'] } as any;
const request = { projectId: 'proj', branch: 'feature/now', jobGroupId: 'grp-1', headSha: 'abc123' };
const sourcePath = 'config/locales/en.yml';

function target(locale: string, base: string | null, current: string) {
  return { locale, target_path: `config/locales/${locale}.yml`, format: 'yml', base, current };
}

function candidate(key = 'profile.published', overrides: Record<string, unknown> = {}) {
  return {
    source_path: sourcePath,
    format: 'yml',
    key,
    source_base: 'Your profile is published',
    source: 'Your profile is published',
    targets: [
      target('sv', 'Din profil är publicerad', 'Din profil är publicerad nu'),
      target('nb', 'Profilen din er publisert', 'Profilen din er publisert'),
      target('fi', null, 'Profiilisi on julkaistu')
    ],
    ...overrides
  };
}

function updated(c: any, extra: Record<string, unknown> = {}) {
  return {
    source_path: c.source_path,
    key: c.key,
    status: 'updated',
    trigger_locale: 'sv',
    trigger_value: 'Din profil är publicerad nu',
    source: 'Your profile is published now',
    align_locales: ['nb', 'fi'],
    trigger_at_base: false,
    ...extra
  };
}

function answered(c: any, status: string) {
  return { source_path: c.source_path, key: c.key, status };
}

function respondWith(itemFor: (item: any) => unknown) {
  return async (params: any) => ({ enabled: true, items: params.items.map(itemFor) });
}

describe('runTargetEditAlignment', () => {
  let mockConsole: { log: jest.Mock };
  let updateTranslationFile: jest.Mock<any>;
  let deps: any;

  beforeEach(() => {
    mockCreateTargetEditAlignment.mockReset();
    mockConsole = { log: jest.fn() };
    updateTranslationFile = jest.fn<any>().mockResolvedValue({ updatedKeys: [], created: false });
    deps = { console: mockConsole, updateTranslationFile, config };
  });

  function logged(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('sends keys in chunks of 25 without the target file formats', async () => {
    const candidates = Array.from({ length: 26 }, (_, i) => candidate(`key_${i}`));
    mockCreateTargetEditAlignment.mockImplementation(respondWith(item => answered(item, 'no_trigger')));

    await runTargetEditAlignment(candidates, request, deps);

    expect(mockCreateTargetEditAlignment.mock.calls.map((call: any) => call[0].items.length)).toEqual([25, 1]);
    expect(mockCreateTargetEditAlignment.mock.calls[0][0]).toMatchObject(request);
    expect(mockCreateTargetEditAlignment.mock.calls[0][0].items[0]).toEqual({
      source_path: sourcePath,
      format: 'yml',
      key: 'key_0',
      source_base: 'Your profile is published',
      source: 'Your profile is published',
      targets: [
        { locale: 'sv', target_path: 'config/locales/sv.yml', base: 'Din profil är publicerad', current: 'Din profil är publicerad nu' },
        { locale: 'nb', target_path: 'config/locales/nb.yml', base: 'Profilen din er publisert', current: 'Profilen din er publisert' },
        { locale: 'fi', target_path: 'config/locales/fi.yml', base: null, current: 'Profiilisi on julkaistu' }
      ]
    });
  });

  it('writes the updated source text into the source file', async () => {
    mockCreateTargetEditAlignment.mockImplementation(respondWith(updated));

    const result = await runTargetEditAlignment([candidate()], request, deps);

    expect(updateTranslationFile).toHaveBeenCalledWith(
      sourcePath,
      { 'profile.published': 'Your profile is published now' },
      'en',
      sourcePath,
      undefined,
      config
    );
    expect(result.writtenPaths).toEqual([sourcePath]);
  });

  it('returns the source cell to stage, marked with the edited text it follows', async () => {
    mockCreateTargetEditAlignment.mockImplementation(respondWith(updated));

    const result = await runTargetEditAlignment([candidate()], request, deps);

    expect(result.sourceCells).toEqual([{
      locale: 'en',
      source_path: sourcePath,
      target_path: sourcePath,
      format: 'yml',
      key: 'profile.published',
      previous_source: 'Your profile is published',
      source: 'Your profile is published now',
      target_base: 'Your profile is published',
      target_current: 'Your profile is published',
      value: 'Your profile is published now',
      trigger_locale: 'sv',
      aligned_source: 'Din profil är publicerad nu'
    }]);
  });

  it('aligns the locales the server names from the source text before the write, anchored on their branch values', async () => {
    mockCreateTargetEditAlignment.mockImplementation(respondWith(updated));

    const result = await runTargetEditAlignment([candidate()], request, deps);

    expect(result.alignmentCandidates).toEqual([
      {
        locale: 'nb',
        source_path: sourcePath,
        target_path: 'config/locales/nb.yml',
        format: 'yml',
        key: 'profile.published',
        previous_source: 'Your profile is published',
        source: 'Your profile is published now',
        target_base: 'Profilen din er publisert',
        target_current: 'Profilen din er publisert',
        trigger_locale: 'sv'
      },
      expect.objectContaining({
        locale: 'fi',
        target_base: 'Profiilisi on julkaistu',
        target_current: 'Profiilisi on julkaistu'
      })
    ]);
  });

  it('matches the locales the server names regardless of separator and case', async () => {
    const c = candidate('title', { targets: [target('sv', 'a', 'b'), target('zh_cn', 'c', 'c')] });
    mockCreateTargetEditAlignment.mockImplementation(respondWith(item => updated(item, { align_locales: ['zh-CN'] })));

    const result = await runTargetEditAlignment([c], request, deps);

    expect(result.alignmentCandidates.map((cell: any) => [cell.locale, cell.target_path])).toEqual([
      ['zh_cn', 'config/locales/zh_cn.yml']
    ]);
  });

  it('sends a trigger back at its merge-base value as a reverted change', async () => {
    const c = candidate('profile.published', {
      source: 'Your profile is published now',
      targets: [target('sv', 'Din profil är publicerad', 'Din profil är publicerad'), target('nb', 'Profilen din er publisert', 'Profilen din er publisert nå')]
    });
    mockCreateTargetEditAlignment.mockImplementation(respondWith(item => updated(item, {
      trigger_value: 'Din profil är publicerad',
      source: 'Your profile is published',
      align_locales: ['nb'],
      trigger_at_base: true
    })));

    const result = await runTargetEditAlignment([c], request, deps);

    expect(result.revertedChanges).toEqual([{
      path: 'config/locales/sv.yml',
      source_path: sourcePath,
      locale: 'sv',
      format: 'yml',
      changes: [{ key: 'profile.published', status: 'reverted', value: 'Din profil är publicerad', old_value: 'Din profil är publicerad' }]
    }]);
    expect(result.alignmentCandidates[0]).toMatchObject({
      locale: 'nb',
      previous_source: 'Your profile is published now',
      source: 'Your profile is published',
      target_base: 'Profilen din er publisert nå'
    });
  });

  it('writes nothing for a local fix or a skipped key and counts them', async () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c'), candidate('d')];
    mockCreateTargetEditAlignment.mockResolvedValue({
      enabled: true,
      items: [
        answered(candidates[0], 'local_fix'),
        answered(candidates[1], 'several_languages_edited'),
        answered(candidates[2], 'reviewer_edited'),
        answered(candidates[3], 'no_trigger')
      ]
    });

    const result = await runTargetEditAlignment(candidates, request, deps);

    expect(updateTranslationFile).not.toHaveBeenCalled();
    expect(result.sourceCells).toEqual([]);
    expect(result.alignmentCandidates).toEqual([]);
    expect(result.localFixes).toBe(1);
    expect(result.skipped).toEqual({ several_languages_edited: 1, reviewer_edited: 1 });
  });

  it('changes nothing and says nothing when the server does not have the endpoint', async () => {
    mockCreateTargetEditAlignment.mockRejectedValue(new TargetEditAlignmentRequestError('Not found', 404));

    const result = await runTargetEditAlignment(Array.from({ length: 30 }, (_, i) => candidate(`key_${i}`)), request, deps);

    expect(mockCreateTargetEditAlignment).toHaveBeenCalledTimes(1);
    expect(result.sourceCells).toEqual([]);
    expect(mockConsole.log).not.toHaveBeenCalled();
  });

  it('changes nothing and says nothing when the feature is off', async () => {
    mockCreateTargetEditAlignment.mockResolvedValue({ enabled: false, items: [] });

    const result = await runTargetEditAlignment(Array.from({ length: 30 }, (_, i) => candidate(`key_${i}`)), request, deps);

    expect(mockCreateTargetEditAlignment).toHaveBeenCalledTimes(1);
    expect(result.sourceCells).toEqual([]);
    expect(mockConsole.log).not.toHaveBeenCalled();
  });

  it('warns on a server or network failure and carries on with the next chunk', async () => {
    const candidates = Array.from({ length: 26 }, (_, i) => candidate(`key_${i}`));
    mockCreateTargetEditAlignment
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(respondWith(updated));

    const result = await runTargetEditAlignment(candidates, request, deps);

    expect(logged()).toContain('Could not update source texts to match edited translations: fetch failed');
    expect(result.sourceCells.map((cell: any) => cell.key)).toEqual(['key_25']);
  });

  it('warns when the server rejects the request', async () => {
    mockCreateTargetEditAlignment.mockRejectedValue(new TargetEditAlignmentRequestError('Duplicate locale sv', 422));

    const result = await runTargetEditAlignment([candidate()], request, deps);

    expect(logged()).toContain('was rejected: Duplicate locale sv');
    expect(result.sourceCells).toEqual([]);
  });

  it('ignores a response that does not match the request', async () => {
    mockCreateTargetEditAlignment.mockResolvedValue({ enabled: true, items: [updated(candidate('other'))] });

    const result = await runTargetEditAlignment([candidate()], request, deps);

    expect(logged()).toContain('did not match the request');
    expect(updateTranslationFile).not.toHaveBeenCalled();
  });

  it('drops a key whose source file could not be written', async () => {
    const c = candidate('profile.published', {
      targets: [target('sv', 'Din profil är publicerad', 'Din profil är publicerad'), target('nb', 'a', 'a')]
    });
    mockCreateTargetEditAlignment.mockImplementation(respondWith(item => updated(item, { align_locales: ['nb'], trigger_at_base: true })));
    updateTranslationFile.mockRejectedValue(new Error('EACCES'));

    const result = await runTargetEditAlignment([c], request, deps);

    expect(logged()).toContain(`Could not write the updated source texts to ${sourcePath}: EACCES`);
    expect(result).toMatchObject({ sourceCells: [], alignmentCandidates: [], revertedChanges: [], writtenPaths: [] });
  });
});

function v1Candidate(key: string, locale: string, extra: Record<string, unknown> = {}) {
  return {
    locale,
    source_path: sourcePath,
    target_path: `config/locales/${locale}.yml`,
    format: 'yml',
    key,
    previous_source: 'Your profile is published',
    source: 'Your profile is published now',
    target_base: 'base',
    target_current: 'current',
    ...extra
  };
}

describe('replaceAlignmentCandidates', () => {
  it('replaces every first-pass candidate of an updated key with the items for the locales to align', () => {
    const stepA = {
      sourceCells: [{ ...v1Candidate('profile.published', 'en'), value: 'x' }],
      alignmentCandidates: [v1Candidate('profile.published', 'nb', { trigger_locale: 'sv' })]
    };

    const result = replaceAlignmentCandidates(
      [v1Candidate('profile.published', 'sv'), v1Candidate('profile.published', 'nb'), v1Candidate('profile.title', 'nb')],
      stepA
    );

    expect(result.map((c: any) => [c.key, c.locale, c.trigger_locale])).toEqual([
      ['profile.title', 'nb', undefined],
      ['profile.published', 'nb', 'sv']
    ]);
  });

  it('keeps a same-named key in another source file', () => {
    const stepA = { sourceCells: [{ ...v1Candidate('title', 'en'), value: 'x' }], alignmentCandidates: [] };

    const result = replaceAlignmentCandidates([v1Candidate('title', 'nb', { source_path: 'config/locales/other.en.yml' })], stepA);

    expect(result).toHaveLength(1);
  });
});

describe('withRevertedChanges', () => {
  it('adds a reverted change to the file the first pass already sends, or as a new file', () => {
    const svFile = { path: 'config/locales/sv.yml', source_path: sourcePath, locale: 'sv', format: 'yml', changes: [{ key: 'a', status: 'updated', value: 'x', old_value: 'y' }] };
    const reverted = (key: string, locale: string) => ({
      path: `config/locales/${locale}.yml`, source_path: sourcePath, locale, format: 'yml',
      changes: [{ key, status: 'reverted', value: 'v', old_value: 'v' }]
    });

    const result = withRevertedChanges([svFile], [reverted('b', 'sv'), reverted('c', 'nb')]);

    expect(result.map((file: any) => [file.locale, file.changes.map((change: any) => change.key)])).toEqual([
      ['sv', ['a', 'b']],
      ['nb', ['c']]
    ]);
    expect(svFile.changes).toHaveLength(1);
  });
});

describe('addSourceCells', () => {
  const sourceCell = { ...v1Candidate('profile.published', 'en'), value: 'Your profile is published now' };

  it('adds the source cells to the aligned cells so they are committed and staged', () => {
    const alignment = { enabled: true, alignedCells: [{ ...v1Candidate('profile.published', 'nb'), value: 'nå' }], localeSummaries: {}, notices: [], shortUrl: 'u' };

    const result = addSourceCells(alignment, [sourceCell]);

    expect(result.alignedCells.map((cell: any) => cell.locale)).toEqual(['nb', 'en']);
    expect(result.shortUrl).toBe('u');
  });

  it('starts a result when nothing else was aligned', () => {
    expect(addSourceCells(null, [sourceCell]).alignedCells).toEqual([sourceCell]);
    expect(addSourceCells(null, [])).toBeNull();
  });
});

describe('refreshFileContent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'target-edit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-reads the content of every entry for a written file', () => {
    const view = path.join(dir, 'show.i18n.yml');
    const other = path.join(dir, 'other.yml');
    writeFileSync(view, 'en:\n  title: "Now"\nsv:\n  title: "Nu"\n');
    const stale = Buffer.from('en:\n  title: "Before"\n').toString('base64');
    const files = [
      { path: view, format: 'yml', locale: 'en', content: stale },
      { path: view, format: 'yml', locale: 'sv', content: stale },
      { path: other, format: 'yml', locale: 'en', content: stale }
    ];

    refreshFileContent(files, [view]);

    const fresh = Buffer.from('en:\n  title: "Now"\nsv:\n  title: "Nu"\n').toString('base64');
    expect(files.map((file) => file.content)).toEqual([fresh, fresh, stale]);
  });
});

describe('reportTargetEditAlignment', () => {
  it('names each source text that follows an edit and counts the rest', () => {
    const log = jest.fn();
    const result = {
      sourceCells: [{ ...v1Candidate('profile.published', 'en'), value: 'x', trigger_locale: 'sv' }],
      localFixes: 2,
      skipped: { several_languages_edited: 1 }
    };

    reportTargetEditAlignment(result, { log });

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('profile.published: en updated to match the sv edit');
    expect(output).toContain('2 left as they are: the edit kept the meaning');
    expect(output).toContain('1 skipped (1 several_languages_edited)');
  });

  it('says nothing when there is nothing to report', () => {
    const log = jest.fn();

    reportTargetEditAlignment({ sourceCells: [], localFixes: 0, skipped: {} }, { log });

    expect(log).not.toHaveBeenCalled();
  });
});
