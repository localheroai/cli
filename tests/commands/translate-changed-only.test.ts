import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { ApiResponseError } from '../../src/types/index.js';

const mockFilterByGitChanges = jest.fn<any>();
const mockDetectTargetChanges = jest.fn<any>();
const mockCreatePullRequestImport = jest.fn<any>();
const mockFinalizeTranslationJobs = jest.fn<any>();

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

  await jest.unstable_mockModule('../../src/api/pull-request-imports.js', () => ({
    createPullRequestImport: mockCreatePullRequestImport
  }));

  const actualGit: any = await import('../../src/utils/git.js');
  await jest.unstable_mockModule('../../src/utils/git.js', () => ({
    ...actualGit,
    getCurrentBranch: async () => 'feature/reword'
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
