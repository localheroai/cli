import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ApiResponseError } from '../../src/types/index.js';

const mockFilterByGitChanges = jest.fn<any>();
const mockDetectTargetChanges = jest.fn<any>();
const mockCreatePullRequestImport = jest.fn<any>();
const mockFinalizeTranslationJobs = jest.fn<any>();
const mockCollectAlignmentCandidates = jest.fn<any>();
const mockCreateSourceAlignment = jest.fn<any>();
const mockProcessTranslationBatches = jest.fn<any>();
const mockKeepAlignedCellsOnDisk = jest.fn<any>();
const mockCollectTargetEditCandidates = jest.fn<any>();
const mockCreateTargetEditAlignment = jest.fn<any>();

let translate: any;
let importGuard: any;

beforeAll(async () => {
  const actualGitChanges: any = await import('../../src/utils/git-changes.js');
  await jest.unstable_mockModule('../../src/utils/git-changes.js', () => ({
    ...actualGitChanges,
    isGitAvailable: () => true,
    filterByGitChanges: mockFilterByGitChanges,
    getManifestForFinalize: () => ({}),
    getRemovedKeysManifestForFinalize: () => null
  }));

  const actualTargetChanges: any = await import('../../src/utils/target-changes.js');
  await jest.unstable_mockModule('../../src/utils/target-changes.js', () => ({
    ...actualTargetChanges,
    detectTargetChanges: mockDetectTargetChanges
  }));

  const actualPullRequestImports: any = await import('../../src/api/pull-request-imports.js');
  await jest.unstable_mockModule('../../src/api/pull-request-imports.js', () => ({
    ...actualPullRequestImports,
    createPullRequestImport: mockCreatePullRequestImport
  }));

  const actualGit: any = await import('../../src/utils/git.js');
  await jest.unstable_mockModule('../../src/utils/git.js', () => ({
    ...actualGit,
    getCurrentBranch: async () => 'feature/reword',
    getHeadSha: async () => 'abc123'
  }));

  await jest.unstable_mockModule('../../src/utils/aligned-values-on-disk.js', () => ({
    keepAlignedCellsOnDisk: mockKeepAlignedCellsOnDisk
  }));

  await jest.unstable_mockModule('../../src/utils/alignment-candidates.js', () => ({
    collectAlignmentCandidates: mockCollectAlignmentCandidates
  }));

  const actualSourceAlignments: any = await import('../../src/api/source-alignments.js');
  await jest.unstable_mockModule('../../src/api/source-alignments.js', () => ({
    ...actualSourceAlignments,
    createSourceAlignment: mockCreateSourceAlignment
  }));

  await jest.unstable_mockModule('../../src/utils/target-edit-candidates.js', () => ({
    collectTargetEditCandidates: mockCollectTargetEditCandidates
  }));

  const actualTargetEditAlignments: any = await import('../../src/api/target-edit-alignments.js');
  await jest.unstable_mockModule('../../src/api/target-edit-alignments.js', () => ({
    ...actualTargetEditAlignments,
    createTargetEditAlignment: mockCreateTargetEditAlignment
  }));

  const actualProcessor: any = await import('../../src/utils/translation-processor.js');
  await jest.unstable_mockModule('../../src/utils/translation-processor.js', () => ({
    ...actualProcessor,
    processTranslationBatches: mockProcessTranslationBatches
  }));

  const actualTranslations: any = await import('../../src/api/translations.js');
  await jest.unstable_mockModule('../../src/api/translations.js', () => ({
    ...actualTranslations,
    finalizeTranslationJobs: mockFinalizeTranslationJobs
  }));

  translate = (await import('../../src/commands/translate.js')).translate;
  importGuard = (await import('../../src/utils/import-guard.js')).importGuard;
});

const sourcePath = 'config/locales/en.yml';
const targetPath = 'config/locales/fr.yml';

beforeEach(() => {
  mockCollectTargetEditCandidates.mockReturnValue([]);
});

function sourceChange(key: string) {
  return {
    path: sourcePath,
    source_path: sourcePath,
    locale: 'en',
    format: 'yaml',
    changes: [{ key, status: 'updated', value: 'Snooze until tomorrow', old_value: 'Remind me tomorrow' }]
  };
}

function targetChange(key: string) {
  return {
    path: targetPath,
    source_path: sourcePath,
    locale: 'fr',
    format: 'yaml',
    changes: [{ key, status: 'added', value: 'Rappel demain' }]
  };
}

describe('translate --changed-only summary', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock; warn: jest.Mock };
  let deps: any;

  beforeAll(() => {
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  beforeEach(() => {
    mockConsole = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    importGuard.setDependencies({ env: {} });
    mockFilterByGitChanges.mockReturnValue({});
    mockFinalizeTranslationJobs.mockResolvedValue({});
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 0, skipped: [], unchanged: [] });
    mockDetectTargetChanges.mockReturnValue([]);
    mockCollectAlignmentCandidates.mockReturnValue([]);

    deps = {
      console: mockConsole,
      configUtils: {
        getProjectConfig: jest.fn<any>().mockResolvedValue({
          projectId: 'demo',
          sourceLocale: 'en',
          outputLocales: ['fr'],
          translationFiles: { paths: ['config/locales/'] }
        }),
        updateLastSyncedAt: jest.fn<any>().mockResolvedValue(true)
      },
      authUtils: { checkAuth: jest.fn<any>().mockResolvedValue(true) },
      settingsUtils: { fetchSettings: jest.fn<any>().mockResolvedValue({ settings: { target_languages: [] } }) },
      fileUtils: {
        findTranslationFiles: jest.fn<any>().mockResolvedValue({
          sourceFiles: [{ path: sourcePath, format: 'yml', locale: 'en', content: '' }],
          targetFilesByLocale: { fr: [{ path: targetPath, format: 'yml', locale: 'fr', content: '' }] },
          allFiles: [{ path: sourcePath, locale: 'en' }, { path: targetPath, locale: 'fr' }]
        })
      },
      translationUtils: {
        createTranslationJob: jest.fn(),
        checkJobStatus: jest.fn(),
        updateTranslationFile: jest.fn(),
        findMissingTranslations: jest.fn(),
        batchKeysWithMissing: jest.fn<any>().mockReturnValue({ batches: [], errors: [] }),
        findMissingTranslationsByLocale: jest.fn<any>().mockReturnValue({ missing: {}, removed: [] })
      },
      gitUtils: { autoCommitChanges: jest.fn() },
      execUtils: { execSync: jest.fn() }
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function loggedLines(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('reports a reworded source text instead of claiming everything is translated', async () => {
    mockDetectTargetChanges.mockReturnValue([sourceChange('reminders.remind_tomorrow')]);
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [], unchanged: [] });

    await translate({ changedOnly: true }, deps);

    const output = loggedLines();
    expect(output).toContain('No changed keys need translation');
    expect(output).not.toContain('already translated');
    expect(output).toContain('1 source text changed');
    expect(output).toContain('Existing translations were kept');
  });

  it('says nothing about source texts when only target edits were sent', async () => {
    mockDetectTargetChanges.mockReturnValue([targetChange('greeting')]);
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [], unchanged: [] });

    await translate({ changedOnly: true }, deps);

    const output = loggedLines();
    expect(output).toContain('Sent 1 translation value from this PR for review');
    expect(output).not.toContain('source text');
  });

  it('reports values that already match instead of counting them as review items', async () => {
    mockDetectTargetChanges.mockReturnValue([targetChange('greeting')]);
    mockCreatePullRequestImport.mockResolvedValue({
      imported_count: 0,
      skipped: [],
      unchanged: [{ path: targetPath, key: 'greeting' }]
    });

    await translate({ changedOnly: true }, deps);

    const output = loggedLines();
    expect(output).toContain('1 translation value already matches');
    expect(output).not.toContain('for review');
  });

  it('warns when the review upload fails, without --verbose', async () => {
    mockDetectTargetChanges.mockReturnValue([sourceChange('reminders.remind_tomorrow')]);
    mockCreatePullRequestImport.mockRejectedValue(new Error('Translation ingestion failed with status 500'));

    await translate({ changedOnly: true }, deps);

    const output = loggedLines();
    expect(output).toContain('Could not send 1 changed value for review');
    expect(output).toContain('status 500');
    expect(output).not.toContain('source text changed');
  });

  describe('when the branch moved after the checkout', () => {
    beforeEach(() => {
      importGuard.setDependencies({
        env: { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/reword', GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'token' },
        git: (args: string[]) => (args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? 'checkout' : 'synced-tip') : ''),
        fetchActionToken: async () => ({ token: null }),
        flatValuesAt: (_file: unknown, ref: string) => (ref === 'checkout'
          ? { greeting: 'Bonjour', farewell: 'Au revoir' }
          : { greeting: 'Bonjour (relu)', farewell: 'Au revoir' })
      });
      mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [], unchanged: [] });
    });

    function frenchEdits(values: Record<string, string>) {
      return [{
        path: targetPath,
        source_path: sourcePath,
        locale: 'fr',
        format: 'yaml',
        changes: Object.entries(values).map(([key, value]) => ({ key, status: 'updated', value }))
      }];
    }

    it('sends only the values the newer commit left alone, and says how many it left out', async () => {
      mockDetectTargetChanges.mockReturnValue(frenchEdits({ greeting: 'Bonjour', farewell: 'Au revoir' }));

      await translate({ changedOnly: true }, deps);

      const sent = mockCreatePullRequestImport.mock.calls[0][0].files;
      expect(sent[0].changes.map((change: any) => change.key)).toEqual(['farewell']);
      expect(loggedLines()).toContain('Left out 1 value the branch changed after this run started');
    });

    it('sends nothing when the newer commit changed every value, so nothing is withdrawn', async () => {
      mockDetectTargetChanges.mockReturnValue(frenchEdits({ greeting: 'Bonjour' }));

      await translate({ changedOnly: true }, deps);

      expect(mockCreatePullRequestImport).not.toHaveBeenCalled();
    });
  });

  it('fails without sending anything or reporting success when the project does not exist', async () => {
    mockDetectTargetChanges.mockReturnValue([targetChange('greeting')]);
    deps.settingsUtils.fetchSettings.mockRejectedValue(
      new ApiResponseError('Project not found', { code: 'project_not_found' })
    );

    await translate({ changedOnly: true }, deps);

    const errors = mockConsole.error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errors).toContain('Project "demo" was not found');
    expect(loggedLines()).not.toContain('✓');
    expect(mockFinalizeTranslationJobs).not.toHaveBeenCalled();
    expect(mockCreatePullRequestImport).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

function candidate(key: string, locale = 'fr', targetPath = targetPath_(locale)) {
  return {
    locale,
    source_path: sourcePath,
    target_path: targetPath,
    format: 'yml',
    key,
    previous_source: 'Remind me tomorrow',
    source: 'Snooze until tomorrow',
    target_base: 'Rappel demain',
    target_current: 'Rappel demain'
  };
}

function targetPath_(locale: string) {
  return `config/locales/${locale}.yml`;
}

function alignedResponse(value: string) {
  return async (params: any) => ({
    enabled: true,
    job_group: { id: params.jobGroupId, short_url: 'https://localhero.ai/r/grp' },
    items: params.items.map((item: any) => ({
      source_path: item.source_path,
      target_path: item.target_path,
      key: item.key,
      status: 'aligned',
      value
    })),
    notices: []
  });
}

describe('translate --changed-only aligning reworded source texts', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock; warn: jest.Mock };
  let deps: any;
  const originalGithubActions = process.env.GITHUB_ACTIONS;

  beforeAll(() => {
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  beforeEach(() => {
    process.env.GITHUB_ACTIONS = 'true';
    mockConsole = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    importGuard.setDependencies({ env: {} });
    mockFilterByGitChanges.mockReturnValue({});
    mockFinalizeTranslationJobs.mockResolvedValue({});
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [], unchanged: [] });
    mockDetectTargetChanges.mockReturnValue([sourceChange('reminders.remind_tomorrow')]);
    mockCollectAlignmentCandidates.mockReturnValue([candidate('reminders.remind_tomorrow')]);
    mockKeepAlignedCellsOnDisk.mockImplementation((cells: any[]) => cells);
    mockCreateSourceAlignment.mockImplementation(alignedResponse('Me le rappeler demain'));

    deps = {
      console: mockConsole,
      configUtils: {
        getProjectConfig: jest.fn<any>().mockResolvedValue({
          projectId: 'demo',
          sourceLocale: 'en',
          outputLocales: ['fr'],
          translationFiles: { paths: ['config/locales/'] }
        }),
        updateLastSyncedAt: jest.fn<any>().mockResolvedValue(true)
      },
      authUtils: { checkAuth: jest.fn<any>().mockResolvedValue(true) },
      settingsUtils: { fetchSettings: jest.fn<any>().mockResolvedValue({ settings: { target_languages: [] } }) },
      fileUtils: {
        findTranslationFiles: jest.fn<any>().mockResolvedValue({
          sourceFiles: [{ path: sourcePath, format: 'yml', locale: 'en', content: '' }],
          targetFilesByLocale: { fr: [{ path: targetPath, format: 'yml', locale: 'fr', content: '' }] },
          allFiles: [{ path: sourcePath, locale: 'en' }, { path: targetPath, locale: 'fr' }]
        })
      },
      translationUtils: {
        createTranslationJob: jest.fn(),
        checkJobStatus: jest.fn(),
        updateTranslationFile: jest.fn<any>().mockResolvedValue({ updatedKeys: [], created: false }),
        findMissingTranslations: jest.fn(),
        batchKeysWithMissing: jest.fn<any>().mockReturnValue({ batches: [{}], errors: [] }),
        findMissingTranslationsByLocale: jest.fn<any>().mockReturnValue({ missing: {}, removed: [] })
      },
      gitUtils: { autoCommitChanges: jest.fn<any>().mockResolvedValue('new') },
      execUtils: { execSync: jest.fn() }
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
  });

  function loggedLines(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  function alignedImports(): any[] {
    return mockCreatePullRequestImport.mock.calls
      .map((call: any) => call[0])
      .filter((params: any) => params.files.some((file: any) => file.changes.some((change: any) => change.aligned_source)));
  }

  function withMissingKeys() {
    mockFilterByGitChanges.mockReturnValue({ 'fr:config/locales/en.yml': { locale: 'fr', keys: { new_key: {} }, keyCount: 1 } });
    mockProcessTranslationBatches.mockResolvedValue({
      totalLanguages: 1,
      languages: ['fr'],
      allJobIds: ['job-1'],
      resultsBaseUrl: null,
      jobGroupShortUrl: 'https://localhero.ai/r/grp',
      skippedLanguages: [],
      uniqueKeysTranslated: new Set(['new_key']),
      failedLanguages: []
    });
  }

  it('carries on without aligning when change detection returns null', async () => {
    mockDetectTargetChanges.mockReturnValue(null);

    await translate({ changedOnly: true }, deps);

    expect(mockCollectAlignmentCandidates).not.toHaveBeenCalled();
    expect(mockCreateSourceAlignment).not.toHaveBeenCalled();
    expect(loggedLines()).not.toContain('more than 1,000');
    expect(loggedLines()).toContain('No changed keys need translation');
  });

  it('leaves keys the ignore rules exclude out of alignment', async () => {
    deps.configUtils.getProjectConfig.mockResolvedValue({
      projectId: 'demo',
      sourceLocale: 'en',
      outputLocales: ['fr'],
      translationFiles: { paths: ['config/locales/'], ignoreKeys: ['admin.*'] }
    });

    await translate({ changedOnly: true }, deps);

    const ignoreMatcher = mockCollectAlignmentCandidates.mock.calls[0][5] as (key: string) => boolean;
    expect(ignoreMatcher('admin.note')).toBe(true);
    expect(ignoreMatcher('reminders.remind_tomorrow')).toBe(false);
  });

  it('asks nothing when no source text was reworded', async () => {
    mockCollectAlignmentCandidates.mockReturnValue([]);

    await translate({ changedOnly: true }, deps);

    expect(mockCreateSourceAlignment).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
  });

  it('computes the imported PR edits before writing aligned values', async () => {
    await translate({ changedOnly: true }, deps);

    const detectOrder = mockDetectTargetChanges.mock.invocationCallOrder[0];
    const collectOrder = mockCollectAlignmentCandidates.mock.invocationCallOrder[0];
    const writeOrder = deps.translationUtils.updateTranslationFile.mock.invocationCallOrder[0];
    expect(detectOrder).toBeLessThan(writeOrder);
    expect(collectOrder).toBeLessThan(writeOrder);
    expect(mockCreatePullRequestImport.mock.calls[0][0].files).toEqual([sourceChange('reminders.remind_tomorrow')]);
  });

  it('writes, commits and stages aligned values when no keys need translation', async () => {
    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      targetPath,
      { 'reminders.remind_tomorrow': 'Me le rappeler demain' },
      'fr',
      sourcePath,
      undefined,
      expect.objectContaining({ projectId: 'demo' })
    );
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledWith('config/locales/', expect.objectContaining({
      keysTranslated: 0,
      keysAligned: 1,
      alignedLanguages: ['fr'],
      viewUrl: 'https://localhero.ai/r/grp'
    }));
    expect(alignedImports()).toHaveLength(1);
    expect(alignedImports()[0].files[0].changes[0]).toMatchObject({
      key: 'reminders.remind_tomorrow',
      value: 'Me le rappeler demain',
      aligned_source: 'Snooze until tomorrow'
    });

    const output = loggedLines();
    expect(output).toContain('fr: 1 aligned');
    expect(output).toContain('No changed keys need translation');
    expect(output).not.toContain('Existing translations were kept');
  });

  it('uses one job group id for alignment, finalize and both imports', async () => {
    await translate({ changedOnly: true }, deps);

    const ids = [
      mockCreateSourceAlignment.mock.calls[0][0].jobGroupId,
      mockFinalizeTranslationJobs.mock.calls[0][0].jobGroupId,
      ...mockCreatePullRequestImport.mock.calls.map((call: any) => call[0].jobGroupId)
    ];
    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('uses the same job group id for the translation jobs', async () => {
    withMissingKeys();

    await translate({ changedOnly: true }, deps);

    const alignmentId = mockCreateSourceAlignment.mock.calls[0][0].jobGroupId;
    expect(mockProcessTranslationBatches.mock.calls[0][5]).toBe(alignmentId);
    expect(mockFinalizeTranslationJobs.mock.calls[0][0].jobGroupId).toBe(alignmentId);
    expect(mockCreatePullRequestImport.mock.calls.every((call: any) => call[0].jobGroupId === alignmentId)).toBe(true);
  });

  it('writes aligned values before translating missing keys and commits both together', async () => {
    withMissingKeys();

    await translate({ changedOnly: true }, deps);

    const writeOrder = deps.translationUtils.updateTranslationFile.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(mockProcessTranslationBatches.mock.invocationCallOrder[0]);
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledTimes(1);
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledWith('config/locales/', expect.objectContaining({
      keysTranslated: 1,
      keysAligned: 1
    }));
    const commitOrder = deps.gitUtils.autoCommitChanges.mock.invocationCallOrder[0];
    const alignedImportCall = mockCreatePullRequestImport.mock.calls.findIndex((call: any) => call[0] === alignedImports()[0]);
    expect(commitOrder).toBeLessThan(mockCreatePullRequestImport.mock.invocationCallOrder[alignedImportCall]);
  });

  it('stages only aligned values that postTranslateCommand left as written', async () => {
    deps.configUtils.getProjectConfig.mockResolvedValue({
      projectId: 'demo',
      sourceLocale: 'en',
      outputLocales: ['fr'],
      translationFiles: { paths: ['config/locales/'] },
      postTranslateCommand: 'npm run format-locales'
    });
    mockCollectAlignmentCandidates.mockReturnValue([candidate('reminders.a'), candidate('reminders.b')]);
    mockKeepAlignedCellsOnDisk.mockImplementation((cells: any[]) => cells.filter((cell) => cell.key !== 'reminders.b'));

    await translate({ changedOnly: true }, deps);

    const postCommandOrder = deps.execUtils.execSync.mock.invocationCallOrder[0];
    const recheckOrder = mockKeepAlignedCellsOnDisk.mock.invocationCallOrder[0];
    expect(postCommandOrder).toBeLessThan(recheckOrder);
    expect(recheckOrder).toBeLessThan(deps.gitUtils.autoCommitChanges.mock.invocationCallOrder[0]);
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledWith('config/locales/', expect.objectContaining({ keysAligned: 1 }));
    const stagedKeys = alignedImports()[0].files[0].changes.map((change: any) => change.key);
    expect(stagedKeys).toEqual(['reminders.a']);
  });

  it('writes nothing and keeps the review hint when the feature is off', async () => {
    mockCreateSourceAlignment.mockResolvedValue({ enabled: false, items: [], notices: [] });

    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
    expect(loggedLines()).toContain('Existing translations were kept');
  });

  it('writes nothing when every value already fits', async () => {
    mockCreateSourceAlignment.mockImplementation(async (params: any) => ({
      enabled: true,
      items: params.items.map((item: any) => ({ ...item, status: 'unchanged' })),
      notices: ['Checked against the live translations']
    }));

    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
    expect(loggedLines()).toContain('fr: 1 already fits');
    expect(loggedLines()).toContain('Checked against the live translations');
  });

  it('carries on without aligning when the backend fails', async () => {
    mockCreateSourceAlignment.mockRejectedValue(new TypeError('fetch failed'));

    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(loggedLines()).toContain('Could not align fr translations');
    expect(loggedLines()).toContain('No changed keys need translation');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('carries on without aligned values when the server rejects keys added in this branch', async () => {
    const { SourceAlignmentRequestError } = await import('../../src/api/source-alignments.js');
    mockCollectAlignmentCandidates.mockReturnValue([
      { ...candidate('reminders.added'), previous_source: null, target_base: null }
    ]);
    mockCreateSourceAlignment.mockRejectedValue(new SourceAlignmentRequestError('each item requires previous_source', 422));

    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
    expect(loggedLines()).toContain('Could not align fr translations of keys added in this branch');
    expect(loggedLines()).toContain('No changed keys need translation');
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([['skipped'], ['no-changes']])('does not stage aligned values when the commit result is %s', async (commitResult) => {
    deps.gitUtils.autoCommitChanges.mockResolvedValue(commitResult);

    await translate({ changedOnly: true }, deps);

    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
  });

  it('fails the run and does not stage aligned values when the commit fails', async () => {
    deps.gitUtils.autoCommitChanges.mockRejectedValue(new Error('push rejected'));

    await translate({ changedOnly: true }, deps);

    expect(alignedImports()).toHaveLength(0);
    expect(loggedLines()).toContain('::error::Translations were not committed: push rejected.');
    expect(process.exitCode).toBe(1);
  });

  it('stages aligned values right after writing under --skip-commit', async () => {
    await translate({ changedOnly: true, skipCommit: true }, deps);

    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(1);
  });

  it('does not stage an aligned value a newer commit set back after ours landed', async () => {
    const atStart = { fr: { 'reminders.remind_tomorrow': 'Rappel demain' }, en: { 'reminders.remind_tomorrow': 'Snooze until tomorrow' } };
    importGuard.setDependencies({
      env: { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/reword', GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'token' },
      git: (args: string[]) => (args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? 'checkout' : 'restore-commit') : ''),
      fetchActionToken: async () => ({ token: null }),
      flatValuesAt: (file: { locale: 'fr' | 'en' }) => atStart[file.locale]
    });

    await translate({ changedOnly: true }, deps);

    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
  });

  describe('under --skip-commit, before the pipeline commits the aligned values', () => {
    const checkout = {
      fr: { 'reminders.remind_tomorrow': 'Rappel demain', 'reminders.later': 'Plus tard' },
      en: { 'reminders.remind_tomorrow': 'Snooze until tomorrow', 'reminders.later': 'Snooze until tomorrow' }
    };

    function guardSees(tipHead: string, tip: Record<string, Record<string, string>>) {
      importGuard.setDependencies({
        env: { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/reword', GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'token' },
        git: (args: string[]) => (args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? 'checkout' : tipHead) : ''),
        fetchActionToken: async () => ({ token: null }),
        flatValuesAt: (file: { locale: 'fr' | 'en' }, ref: string) => (ref === 'checkout' ? checkout : tip)[file.locale]
      });
    }

    function alignedKeys(): string[] {
      return alignedImports().flatMap((params: any) => params.files.flatMap((file: any) => file.changes.map((change: any) => change.key)));
    }

    beforeEach(() => {
      mockCollectAlignmentCandidates.mockReturnValue([candidate('reminders.remind_tomorrow'), candidate('reminders.later')]);
    });

    it('stages every aligned value when the branch has not moved', async () => {
      guardSees('checkout', checkout);

      await translate({ changedOnly: true, skipCommit: true }, deps);

      expect(alignedKeys()).toEqual(['reminders.remind_tomorrow', 'reminders.later']);
    });

    it('stages every aligned value when a newer commit left their cells alone', async () => {
      guardSees('unrelated-push', checkout);

      await translate({ changedOnly: true, skipCommit: true }, deps);

      expect(alignedKeys()).toEqual(['reminders.remind_tomorrow', 'reminders.later']);
    });

    it('leaves out only the aligned value a sync changed after the checkout', async () => {
      guardSees('sync', { ...checkout, fr: { ...checkout.fr, 'reminders.remind_tomorrow': 'Rappel demain (relu)' } });

      await translate({ changedOnly: true, skipCommit: true }, deps);

      expect(alignedKeys()).toEqual(['reminders.later']);
      expect(loggedLines()).toContain('Left out 1 value the branch changed after this run started');
    });
  });

  it('never stages aligned values outside GitHub Actions', async () => {
    delete process.env.GITHUB_ACTIONS;

    await translate({ changedOnly: true, skipCommit: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
  });
});

describe('translate --changed-only following an edited translation', () => {
  const english = 'Your profile is published';
  const englishNow = 'Your profile is published now';
  const swedishNow = 'Din profil är publicerad nu';
  const norwegian = 'Profilen din er publisert';
  let dir: string;
  let enPath: string;
  let mockConsole: { log: jest.Mock; error: jest.Mock; warn: jest.Mock };
  let deps: any;
  const originalGithubActions = process.env.GITHUB_ACTIONS;

  function englishFile(value: string): string {
    return `en:\n  profile:\n    published: "${value}"\n`;
  }

  function stepACandidate() {
    return {
      source_path: enPath,
      format: 'yml',
      key: 'profile.published',
      source_base: english,
      source: english,
      targets: [
        { locale: 'sv', target_path: path.join(dir, 'sv.yml'), format: 'yml', writable: true, base: 'Din profil är publicerad', current: swedishNow },
        { locale: 'nb', target_path: path.join(dir, 'nb.yml'), format: 'yml', writable: true, base: norwegian, current: norwegian }
      ]
    };
  }

  function stepAAnswer(extra: Record<string, unknown> = {}) {
    return async (params: any) => ({
      enabled: true,
      items: params.items.map((item: any) => ({
        source_path: item.source_path,
        key: item.key,
        status: 'updated',
        trigger_locale: 'sv',
        trigger_value: swedishNow,
        source: englishNow,
        align_locales: ['nb'],
        trigger_at_base: false,
        ...extra
      }))
    });
  }

  function svChange() {
    return {
      path: path.join(dir, 'sv.yml'),
      source_path: enPath,
      locale: 'sv',
      format: 'yml',
      changes: [{ key: 'profile.published', status: 'updated', value: swedishNow, old_value: 'Din profil är publicerad' }]
    };
  }

  beforeAll(() => {
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  beforeEach(() => {
    process.env.GITHUB_ACTIONS = 'true';
    dir = mkdtempSync(path.join(tmpdir(), 'follow-edit-'));
    enPath = path.join(dir, 'en.yml');
    writeFileSync(enPath, englishFile(english));

    mockConsole = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockFilterByGitChanges.mockReturnValue({});
    mockFinalizeTranslationJobs.mockResolvedValue({});
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [], unchanged: [] });
    mockDetectTargetChanges.mockReturnValue([svChange()]);
    mockCollectAlignmentCandidates.mockReturnValue([]);
    mockCollectTargetEditCandidates.mockReturnValue([stepACandidate()]);
    mockCreateTargetEditAlignment.mockImplementation(stepAAnswer());
    mockKeepAlignedCellsOnDisk.mockImplementation((cells: any[]) => cells);
    mockCreateSourceAlignment.mockImplementation(alignedResponse('Profilen din er publisert nå'));

    deps = {
      console: mockConsole,
      configUtils: {
        getProjectConfig: jest.fn<any>().mockResolvedValue({
          projectId: 'demo',
          sourceLocale: 'en',
          outputLocales: ['sv', 'nb'],
          translationFiles: { paths: ['config/locales/'] }
        }),
        updateLastSyncedAt: jest.fn<any>().mockResolvedValue(true)
      },
      authUtils: { checkAuth: jest.fn<any>().mockResolvedValue(true) },
      settingsUtils: { fetchSettings: jest.fn<any>().mockResolvedValue({ settings: { target_languages: [] } }) },
      fileUtils: {
        findTranslationFiles: jest.fn<any>().mockResolvedValue({
          sourceFiles: [{ path: enPath, format: 'yml', locale: 'en', content: Buffer.from(englishFile(english)).toString('base64') }],
          targetFilesByLocale: {
            sv: [{ path: path.join(dir, 'sv.yml'), format: 'yml', locale: 'sv', content: '' }],
            nb: [{ path: path.join(dir, 'nb.yml'), format: 'yml', locale: 'nb', content: '' }]
          },
          allFiles: [{ path: enPath, locale: 'en' }]
        })
      },
      translationUtils: {
        createTranslationJob: jest.fn(),
        checkJobStatus: jest.fn(),
        updateTranslationFile: jest.fn<any>().mockImplementation(async (filePath: string, values: Record<string, string>) => {
          if (filePath === enPath) writeFileSync(enPath, englishFile(values['profile.published']));
          return { updatedKeys: Object.keys(values), created: false };
        }),
        findMissingTranslations: jest.fn(),
        batchKeysWithMissing: jest.fn<any>().mockReturnValue({ batches: [{}], errors: [] }),
        findMissingTranslationsByLocale: jest.fn<any>().mockReturnValue({ missing: {}, removed: [] })
      },
      gitUtils: { autoCommitChanges: jest.fn<any>().mockResolvedValue('new') },
      execUtils: { execSync: jest.fn() }
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
  });

  function loggedLines(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  function alignedImport(): any {
    return mockCreatePullRequestImport.mock.calls
      .map((call: any) => call[0])
      .find((params: any) => params.files.some((file: any) => file.changes.some((change: any) => change.aligned_source)));
  }

  function changeIn(params: any, locale: string): any {
    return params.files.find((file: any) => file.locale === locale)?.changes[0];
  }

  it('writes the source text, aligns the other locales from it, commits, then stages both', async () => {
    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      enPath, { 'profile.published': englishNow }, 'en', enPath, undefined, expect.objectContaining({ projectId: 'demo' })
    );
    expect(mockCreateSourceAlignment).toHaveBeenCalledTimes(1);
    expect(mockCreateSourceAlignment.mock.calls[0][0]).toMatchObject({ locale: 'nb' });
    expect(mockCreateSourceAlignment.mock.calls[0][0].items).toEqual([expect.objectContaining({
      key: 'profile.published',
      previous_source: english,
      source: englishNow,
      target_base: norwegian,
      target_current: norwegian
    })]);
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledWith('config/locales/', expect.objectContaining({
      keysAligned: 1,
      alignedLanguages: ['nb'],
      sourceTextsUpdated: 1
    }));
    expect(changeIn(alignedImport(), 'en')).toMatchObject({ value: englishNow, aligned_source: swedishNow, trigger_locale: 'sv' });
    expect(changeIn(alignedImport(), 'nb')).toMatchObject({ aligned_source: englishNow, trigger_locale: 'sv' });
    expect(loggedLines()).toContain('profile.published: en updated to match the sv edit');
  });

  it('runs detection, the edit check and its write ahead of missing keys, alignment and the commit', async () => {
    await translate({ changedOnly: true }, deps);

    const order = [
      mockDetectTargetChanges,
      mockCreateTargetEditAlignment,
      deps.translationUtils.updateTranslationFile,
      deps.translationUtils.findMissingTranslationsByLocale,
      mockFilterByGitChanges,
      mockCollectAlignmentCandidates,
      mockCreateSourceAlignment,
      mockFinalizeTranslationJobs
    ].map((mock: any) => mock.mock.invocationCallOrder[0]);
    const [firstImport, secondImport] = mockCreatePullRequestImport.mock.invocationCallOrder;
    order.push(firstImport, deps.gitUtils.autoCommitChanges.mock.invocationCallOrder[0], secondImport);

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(mockCreatePullRequestImport.mock.calls[0][0].files).toEqual([svChange()]);
  });

  it('looks for missing translations in the source text as written, so a missing locale is translated from it', async () => {
    await translate({ changedOnly: true }, deps);

    const sourceFiles = deps.translationUtils.findMissingTranslationsByLocale.mock.calls[0][0];
    expect(Buffer.from(sourceFiles[0].content, 'base64').toString()).toContain(englishNow);
  });

  it('commits a run that only updates the source text', async () => {
    mockCreateTargetEditAlignment.mockImplementation(stepAAnswer({ align_locales: [] }));

    await translate({ changedOnly: true }, deps);

    expect(mockCreateSourceAlignment).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).toHaveBeenCalledWith('config/locales/', expect.objectContaining({
      keysAligned: 0,
      alignedLanguages: [],
      sourceTextsUpdated: 1
    }));
    expect(changeIn(alignedImport(), 'en')).toMatchObject({ value: englishNow, aligned_source: swedishNow });
  });

  it('aligns a key whose source text followed the edit from the edit check items instead of its first-pass rewording', async () => {
    const pass1 = (key: string) => ({
      locale: 'nb',
      source_path: enPath,
      target_path: path.join(dir, 'nb.yml'),
      format: 'yml',
      key,
      previous_source: 'Old English',
      source: english,
      target_base: 'gammel',
      target_current: norwegian
    });
    mockCollectAlignmentCandidates.mockReturnValue([pass1('profile.published'), pass1('profile.title')]);

    await translate({ changedOnly: true }, deps);

    const items = mockCreateSourceAlignment.mock.calls[0][0].items;
    expect(items.map((item: any) => [item.key, item.previous_source])).toEqual([
      ['profile.title', 'Old English'],
      ['profile.published', english]
    ]);
  });

  it('withdraws the edited translation\'s own proposal when the edit was undone', async () => {
    const reverted = { ...stepACandidate(), source: englishNow };
    reverted.targets[0] = { ...reverted.targets[0], current: 'Din profil är publicerad' };
    mockCollectTargetEditCandidates.mockReturnValue([reverted]);
    mockDetectTargetChanges.mockReturnValue([]);
    mockCreateTargetEditAlignment.mockImplementation(stepAAnswer({
      trigger_value: 'Din profil är publicerad',
      source: english,
      trigger_at_base: true
    }));

    await translate({ changedOnly: true }, deps);

    expect(mockCreatePullRequestImport.mock.calls[0][0].files).toEqual([{
      path: path.join(dir, 'sv.yml'),
      source_path: enPath,
      locale: 'sv',
      format: 'yml',
      changes: [{ key: 'profile.published', status: 'reverted', value: 'Din profil är publicerad', old_value: 'Din profil är publicerad' }]
    }]);
  });

  it('stops before asking about edited translations when a file could not be read', async () => {
    const { recordUnreadableFile } = await import('../../src/utils/unreadable-files.js');
    mockDetectTargetChanges.mockImplementation(() => {
      recordUnreadableFile(path.join(dir, 'nb.yml'));
      return [svChange()];
    });

    await translate({ changedOnly: true }, deps);

    expect(mockCreateTargetEditAlignment).not.toHaveBeenCalled();
    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(mockCreatePullRequestImport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('runs as before on a server without the endpoint', async () => {
    const { TargetEditAlignmentRequestError } = await import('../../src/api/target-edit-alignments.js');
    mockCreateTargetEditAlignment.mockRejectedValue(new TargetEditAlignmentRequestError('Not found', 404));

    await translate({ changedOnly: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).not.toHaveBeenCalled();
    expect(mockCreateSourceAlignment).not.toHaveBeenCalled();
    expect(deps.gitUtils.autoCommitChanges).not.toHaveBeenCalled();
    expect(mockCreatePullRequestImport.mock.calls[0][0].files).toEqual([svChange()]);
    expect(loggedLines()).not.toContain('source texts');
    expect(loggedLines()).toContain('No changed keys need translation');
  });
});
