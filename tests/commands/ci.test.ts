import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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

  describe('PR context detection', () => {
    it('should use --changed-only for feature branch PRs', async () => {
      mockEnv.GITHUB_BASE_REF = 'feature-branch';

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
          changedOnly: true,
          verbose: false
        })
      );
    });

    it('should use full translation for main branch', async () => {
      mockEnv.GITHUB_BASE_REF = 'main';

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
          changedOnly: false,
          verbose: false
        })
      );
    });

    it('should use full translation for master branch', async () => {
      mockEnv.GITHUB_BASE_REF = 'master';

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
          changedOnly: false,
          verbose: false
        })
      );
    });

    it('should use full translation when GITHUB_BASE_REF is not set', async () => {
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
          changedOnly: false,
          verbose: false
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

  describe('translate command integration', () => {
    it('should pass through all options to translate command', async () => {
      mockEnv.GITHUB_BASE_REF = 'feature-branch';

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
  });
});
