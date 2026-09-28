import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { ApiResponseError } from '../../src/types/index.js';

const mockFilterByGitChanges = jest.fn<any>();
const mockDetectTargetChanges = jest.fn<any>();
const mockCreatePullRequestImport = jest.fn<any>();
const mockFinalizeTranslationJobs = jest.fn<any>();
const mockCollectAlignmentCandidates = jest.fn<any>();
const mockCreateSourceAlignment = jest.fn<any>();
const mockProcessTranslationBatches = jest.fn<any>();
const mockKeepAlignedCellsOnDisk = jest.fn<any>();

let translate: any;

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
});

const sourcePath = 'config/locales/en.yml';
const targetPath = 'config/locales/fr.yml';

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

  it('carries on without alignment candidates when change detection returns null', async () => {
    mockDetectTargetChanges.mockReturnValue(null);

    await translate({ changedOnly: true }, deps);

    expect(mockCollectAlignmentCandidates.mock.calls[0][0]).toEqual([]);
    expect(loggedLines()).not.toContain('more than 1,000');
    expect(loggedLines()).toContain('No changed keys need translation');
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

  it('never stages aligned values outside GitHub Actions', async () => {
    delete process.env.GITHUB_ACTIONS;

    await translate({ changedOnly: true, skipCommit: true }, deps);

    expect(deps.translationUtils.updateTranslationFile).toHaveBeenCalled();
    expect(alignedImports()).toHaveLength(0);
  });
});
