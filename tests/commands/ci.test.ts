import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ci, CiOptions } from '../../src/commands/ci.js';
import type { TranslationOptions } from '../../src/commands/translate.js';

describe('ci command', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock };
  let mockConfigUtils: any;
  let mockAuthUtils: { checkAuth: jest.Mock };
  let mockGithubUtils: { isGitHubAction: jest.Mock };
  let mockTranslateCommand: jest.Mock;
  let mockEnv: Record<string, string>;

  beforeEach(() => {
    mockConsole = {
      log: jest.fn(),
      error: jest.fn()
    };

    mockConfigUtils = {
      getProjectConfig: jest.fn().mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['fr', 'de'],
        translationFiles: {
          paths: ['locales/']
        }
      })
    };

    mockAuthUtils = {
      checkAuth: jest.fn().mockResolvedValue(true)
    };

    mockGithubUtils = {
      isGitHubAction: jest.fn().mockReturnValue(true)
    };

    mockTranslateCommand = jest.fn().mockResolvedValue(undefined);

    mockEnv = {
      GITHUB_ACTIONS: 'true'
    };
  });

  describe('branch-based mode detection', () => {
    it('should use --changed-only on feature branch (via GITHUB_HEAD_REF in PR)', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature/new-feature';

      await ci({ verbose: false }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          changedOnly: true
        })
      );
    });

    it('should use --changed-only on feature branch (via GITHUB_REF_NAME on push)', async () => {
      mockEnv.GITHUB_REF_NAME = 'develop';

      await ci({ verbose: false }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          changedOnly: true
        })
      );
    });

    it('should use full translation on main branch', async () => {
      mockEnv.GITHUB_REF_NAME = 'main';

      await ci({ verbose: false }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          changedOnly: false
        })
      );
    });

    it('should use full translation on master branch', async () => {
      mockEnv.GITHUB_REF_NAME = 'master';

      await ci({ verbose: false }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          changedOnly: false
        })
      );
    });

    it('should prefer GITHUB_HEAD_REF over GITHUB_REF_NAME (PR scenario)', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature/foo';
      mockEnv.GITHUB_REF_NAME = 'main';

      await ci({ verbose: false }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          changedOnly: true
        })
      );
    });
  });


  describe('authentication and configuration', () => {
    it('should exit with error if not authenticated', async () => {
      mockAuthUtils.checkAuth.mockResolvedValue(false);

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`Process exit: ${code}`);
      });

      await expect(
        ci({}, {
          console: mockConsole,
          configUtils: mockConfigUtils,
          authUtils: mockAuthUtils,
          githubUtils: mockGithubUtils,
          env: mockEnv,
          translateCommand: mockTranslateCommand
        })
      ).rejects.toThrow('Process exit: 1');

      expect(mockConsole.error).toHaveBeenCalledWith(
        expect.stringContaining('API key is invalid')
      );

      mockExit.mockRestore();
    });

    it('should exit with error if no configuration found', async () => {
      mockConfigUtils.getProjectConfig.mockResolvedValue(null);

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`Process exit: ${code}`);
      });

      await expect(
        ci({}, {
          console: mockConsole,
          configUtils: mockConfigUtils,
          authUtils: mockAuthUtils,
          githubUtils: mockGithubUtils,
          env: mockEnv,
          translateCommand: mockTranslateCommand
        })
      ).rejects.toThrow('Process exit: 1');

      expect(mockConsole.error).toHaveBeenCalledWith(
        expect.stringContaining('No configuration found')
      );

      mockExit.mockRestore();
    });

    it('should warn if not running in CI/CD', async () => {
      mockGithubUtils.isGitHubAction.mockReturnValue(false);

      await ci({}, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockConsole.error).toHaveBeenCalledWith(
        expect.stringContaining('Warning: This command is designed to run in CI/CD environments')
      );

      expect(mockTranslateCommand).toHaveBeenCalled();
    });
  });

  describe('sync mode detection', () => {
    let mockExit: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
      mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`Process exit: ${code}`);
      });
    });

    afterEach(() => {
      mockExit.mockRestore();
    });

    it('should detect sync mode from LOCALHERO_SYNC_ID env var', async () => {
      mockEnv.LOCALHERO_SYNC_ID = 'sync_abc123';

      await expect(ci({ verbose: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      })).rejects.toThrow();

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Sync mode detected')
      );
      expect(mockTranslateCommand).not.toHaveBeenCalled();
    });

    it('should detect sync mode from config.syncTriggerId (backward compat)', async () => {
      mockConfigUtils.getProjectConfig.mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['fr'],
        translationFiles: { paths: ['locales/'] },
        syncTriggerId: 'sync_from_config'
      });

      await expect(ci({ verbose: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      })).rejects.toThrow();

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Sync mode detected')
      );
      expect(mockTranslateCommand).not.toHaveBeenCalled();
    });

    it('should prefer LOCALHERO_SYNC_ID env var over config.syncTriggerId', async () => {
      mockEnv.LOCALHERO_SYNC_ID = 'sync_from_env';

      mockConfigUtils.getProjectConfig.mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['fr'],
        translationFiles: { paths: ['locales/'] },
        syncTriggerId: 'sync_from_config'
      });

      await expect(ci({ verbose: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      })).rejects.toThrow();

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Sync mode detected')
      );
      expect(mockTranslateCommand).not.toHaveBeenCalled();
    });

    it('should pass syncUpdateVersion from LOCALHERO_SYNC_VERSION env var', async () => {
      mockEnv.LOCALHERO_SYNC_ID = 'sync_abc123';
      mockEnv.LOCALHERO_SYNC_VERSION = '3';

      await expect(ci({ verbose: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      })).rejects.toThrow();

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Sync mode detected')
      );
      expect(mockTranslateCommand).not.toHaveBeenCalled();
    });

    it('should enter translate mode when no sync trigger is present', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature/test';

      await ci({ verbose: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Translate mode detected')
      );
      expect(mockTranslateCommand).toHaveBeenCalled();
    });
  });

  describe('translate command integration', () => {
    it('should pass through all options to translate command', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      const options: CiOptions = {
        verbose: true,
        someCustomOption: 'value',
        anotherOption: 123
      };

      await ci(options, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          verbose: true,
          someCustomOption: 'value',
          anotherOption: 123,
          changedOnly: true
        })
      );
    });

    it('should pass skipCommit option to translate command', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      await ci({ skipCommit: true }, {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: mockGithubUtils,
        env: mockEnv,
        translateCommand: mockTranslateCommand
      });

      expect(mockTranslateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          skipCommit: true,
          changedOnly: true
        })
      );
    });
  });

  describe('sync mode auto-commit', () => {
    const syncResponse = {
      sync: {
        sync_id: 'sync_abc',
        status: 'completed',
        created_at: '2026-04-23T00:00:00Z',
        sync_url: 'https://example.com/sync',
        branch_name: 'localhero/sync',
        modified_keys_count: 1,
        files: [
          {
            path: 'locales/fr.json',
            language: 'fr',
            translations: [{
              key: 'hello',
              name: 'hello',
              value: 'Bonjour',
              updated_at: '2026-04-23T00:00:00Z'
            }]
          }
        ]
      },
      pagination: {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        next_page: null,
        prev_page: null,
        items_per_page: 500
      }
    };

    function buildSyncDeps() {
      mockConfigUtils.getValidProjectConfig = jest.fn().mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['fr'],
        translationFiles: { paths: ['locales/'] }
      });
      mockConfigUtils.saveProjectConfig = jest.fn().mockResolvedValue(undefined);

      return {
        console: mockConsole,
        configUtils: mockConfigUtils,
        authUtils: mockAuthUtils,
        githubUtils: {
          ...mockGithubUtils,
          autoCommitSyncChanges: jest.fn().mockResolvedValue(undefined)
        },
        env: mockEnv,
        translateCommand: mockTranslateCommand,
        syncApi: {
          getSyncTranslations: jest.fn().mockResolvedValue(syncResponse),
          completeSyncUpdate: jest.fn().mockResolvedValue({ success: true })
        },
        updateTranslationFile: jest.fn().mockResolvedValue(undefined)
      };
    }

    it('skips autoCommitSyncChanges when skipCommit is set', async () => {
      mockEnv.LOCALHERO_SYNC_ID = 'sync_abc';
      const deps = buildSyncDeps();

      await ci({ skipCommit: true }, deps);

      expect(deps.updateTranslationFile).toHaveBeenCalled();
      expect(deps.githubUtils.autoCommitSyncChanges).not.toHaveBeenCalled();
    });

    it('calls autoCommitSyncChanges when skipCommit is not set', async () => {
      mockEnv.LOCALHERO_SYNC_ID = 'sync_abc';
      const deps = buildSyncDeps();

      await ci({}, deps);

      expect(deps.githubUtils.autoCommitSyncChanges).toHaveBeenCalledTimes(1);
    });
  });
});
