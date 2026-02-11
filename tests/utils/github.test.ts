import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { githubService, createGitHubActionFile, autoCommitChanges, workflowExists, fetchActionToken } from '../../src/utils/github.js';

describe('githubService', () => {
  let mockExec: jest.Mock;
  let mockFs: {
    mkdir: jest.Mock;
    writeFile: jest.Mock;
    existsSync: jest.Mock;
  };
  let mockPath: { join: jest.Mock };
  let mockEnv: Record<string, string>;
  let mockConsole: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let originalConsole: Console;

  beforeEach(() => {
    mockExec = jest.fn();
    mockFs = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      existsSync: jest.fn().mockReturnValue(false)
    };
    mockPath = {
      join: jest.fn((...args: string[]) => args.join('/'))
    };
    mockEnv = {};

    originalConsole = { ...console } as Console;
    mockConsole = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    githubService.setDependencies({
      exec: mockExec,
      fs: mockFs as any,
      path: mockPath as any,
      env: mockEnv,
      console: mockConsole
    });
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  describe('getBranchName', () => {
    it('should return GITHUB_HEAD_REF', () => {
      mockEnv.GITHUB_HEAD_REF = 'feature/from-env';
      expect(githubService.getBranchName()).toBe('feature/from-env');
    });

    it('should throw when GITHUB_HEAD_REF is not set', () => {
      expect(() => githubService.getBranchName()).toThrow('Could not determine branch name');
    });
  });

  describe('canAmendLastCommit', () => {
    it('should return false when not in sync mode', () => {
      expect(githubService.canAmendLastCommit(false)).toBe(false);
    });

    it('should return true when sync mode + bot author + localhero.json has syncTriggerId', () => {
      mockExec
        .mockReturnValueOnce(Buffer.from('hi@localhero.ai\n'))
        .mockReturnValueOnce(Buffer.from('+  "syncTriggerId": "sync_abc123"\n'));

      expect(githubService.canAmendLastCommit(true)).toBe(true);
    });

    it('should return false when sync mode + bot author + no syncTriggerId in diff', () => {
      mockExec
        .mockReturnValueOnce(Buffer.from('hi@localhero.ai\n'))
        .mockReturnValueOnce(Buffer.from('+  "projectId": "proj_123"\n'));

      expect(githubService.canAmendLastCommit(true)).toBe(false);
    });

    it('should return false when sync mode + developer commit', () => {
      mockExec
        .mockReturnValueOnce(Buffer.from('dev@example.com\n'));

      expect(githubService.canAmendLastCommit(true)).toBe(false);
    });

    it('should return false when git command fails', () => {
      mockExec.mockImplementation(() => { throw new Error('git error'); });

      expect(githubService.canAmendLastCommit(true)).toBe(false);
    });
  });

  describe('createGitHubActionFile', () => {
    it('creates workflow file with correct content', async () => {
      const basePath = '/project';
      const translationPaths = ['locales/**/*.json', 'translations/*.yml'];

      const result = await createGitHubActionFile(basePath, translationPaths);

      expect(mockFs.mkdir).toHaveBeenCalledWith('/project/.github/workflows', { recursive: true });
      expect(mockPath.join).toHaveBeenCalledWith(basePath, '.github', 'workflows');
      expect(mockPath.join).toHaveBeenCalledWith('/project/.github/workflows', 'localhero-translate.yml');

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const fileContent = (mockFs.writeFile.mock.calls[0] as unknown[])[1] as string;

      expect(fileContent).toContain('name: Localhero.ai - Automatic I18n translation');
      expect(fileContent).toContain('- "locales/**/*.json"');
      expect(fileContent).toContain('- "translations/*.yml"');
      expect(fileContent).toContain('fetch-depth: 0');
      expect(fileContent).toContain('uses: localheroai/localhero-action@v1');
      expect(fileContent).toContain('api-key: ${{ secrets.LOCALHERO_API_KEY }}');

      expect(result).toBe('/project/.github/workflows/localhero-translate.yml');
    });

    it('handles directory paths without patterns correctly', async () => {
      await createGitHubActionFile('/project', ['locales', 'translations/', 'src/i18n']);

      const fileContent = (mockFs.writeFile.mock.calls[0] as unknown[])[1] as string;
      expect(fileContent).toContain('- "locales/**"');
      expect(fileContent).toContain('- "translations/**"');
      expect(fileContent).toContain('- "src/i18n/**"');
    });

    it('handles mixed paths with and without patterns', async () => {
      await createGitHubActionFile('/project', ['locales/**/*.{json,yml}', 'translations', 'i18n/*.json']);

      const fileContent = (mockFs.writeFile.mock.calls[0] as unknown[])[1] as string;
      expect(fileContent).toContain('- "locales/**/*.{json,yml}"');
      expect(fileContent).toContain('- "translations/**"');
      expect(fileContent).toContain('- "i18n/*.json"');
    });
  });

  describe('workflowExists', () => {
    it('returns true when workflow file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      expect(workflowExists('/project')).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/project/.github/workflows/localhero-translate.yml');
    });

    it('returns false when workflow file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(workflowExists('/project')).toBe(false);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/project/.github/workflows/localhero-translate.yml');
    });
  });

  describe('fetchActionToken', () => {
    let mockFetchToken: jest.Mock;
    let mockConfigSvc: { getProjectConfig: jest.Mock };

    beforeEach(() => {
      mockFetchToken = jest.fn();
      mockConfigSvc = { getProjectConfig: jest.fn() };
      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });
    });

    it('returns token when backend responds successfully', async () => {
      mockConfigSvc.getProjectConfig.mockResolvedValue({ projectId: 'test-project' });
      mockFetchToken.mockResolvedValue('ghs_test_token_123');

      const result = await fetchActionToken();

      expect(result.token).toBe('ghs_test_token_123');
      expect(result.errorCode).toBeUndefined();
      expect(mockFetchToken).toHaveBeenCalledWith('test-project');
    });

    it('returns null with error code when GitHub App not installed', async () => {
      mockConfigSvc.getProjectConfig.mockResolvedValue({ projectId: 'test-project' });
      const error = new Error('GitHub App not installed') as Error & { code?: string };
      error.code = 'github_app_not_installed';
      mockFetchToken.mockRejectedValue(error);

      const result = await fetchActionToken();

      expect(result.token).toBeNull();
      expect(result.errorCode).toBe('github_app_not_installed');
    });

    it('returns null with undefined error code on unexpected error', async () => {
      mockConfigSvc.getProjectConfig.mockResolvedValue({ projectId: 'test-project' });
      mockFetchToken.mockRejectedValue(new Error('Unexpected error'));

      const result = await fetchActionToken();

      expect(result.token).toBeNull();
      expect(result.errorCode).toBeUndefined();
    });
  });

  describe('autoCommitChanges', () => {
    it('does nothing when not in GitHub Actions', () => {
      mockEnv.GITHUB_ACTIONS = 'false';
      autoCommitChanges('locales/**/*.json');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('commits and pushes changes when in GitHub Actions', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      expect(mockExec).toHaveBeenCalledWith('git config --global user.name "LocalHero Bot"', { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git config --global user.email "hi@localhero.ai"', { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git add locales/**/*.json', { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git status --porcelain');
      expect(mockExec).toHaveBeenCalledWith("git commit -m 'Update translations'", { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git push origin HEAD:feature-branch', { stdio: 'inherit' });
    });

    it('commits with enhanced message when translation summary provided', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json', {
        keysTranslated: 15,
        languages: ['German', 'French', 'Spanish'],
        viewUrl: 'https://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ'
      });

      const expectedMessage = 'Update translations\n\nSynced 15 keys in German, French, Spanish\nhttps://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: 'inherit' });
    });

    it('does not commit when there are no changes', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      expect(mockExec).not.toHaveBeenCalledWith("git commit -m 'Update translations'", { stdio: 'inherit' });
      expect(mockConsole.log).toHaveBeenCalledWith('No changes to commit.');
    });

    it('throws error when branch name is missing', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('Could not determine branch name from GITHUB_HEAD_REF');
    });

    it('throws error when GitHub token is missing', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('GITHUB_TOKEN is not set');
    });

    it('throws error when repository is missing', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      githubService.sleep = jest.fn().mockResolvedValue(undefined) as any;

      await expect(githubService.autoCommitChanges('locales/**/*.json')).rejects.toThrow('GITHUB_REPOSITORY is not set');
    });

    it('handles git command errors', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git commit -m 'Update translations'") throw new Error('Git commit failed');
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('Git commit failed');
      expect(mockConsole.error).toHaveBeenCalledWith('Auto-commit failed:', 'Git commit failed');
    });

    it('uses app token when fetchGitHubInstallationToken succeeds', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'github-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      const mockFetchToken = jest.fn().mockResolvedValue('ghs_app_token_123');
      const mockConfigSvc = { getProjectConfig: jest.fn().mockResolvedValue({ projectId: 'test-project' }) };

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockFetchToken).toHaveBeenCalledWith('test-project');
      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:ghs_app_token_123@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(mockConsole.log).toHaveBeenCalledWith('✓ Using GitHub App token');
    });

    it('falls back to GITHUB_TOKEN when fetchGitHubInstallationToken fails', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'github-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      const mockFetchToken = jest.fn().mockRejectedValue(new Error('Network error'));
      const mockConfigSvc = { getProjectConfig: jest.fn().mockResolvedValue({ projectId: 'test-project' }) };

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:github-token@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(mockConsole.warn).toHaveBeenCalledWith(
        '⚠️  Warning: Failed to fetch GitHub App token. Using GITHUB_TOKEN instead (workflows will not trigger).'
      );
    });

    it('silently falls back to GITHUB_TOKEN when GitHub App not installed', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'github-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      const error = new Error('GitHub App not installed') as Error & { code?: string };
      error.code = 'github_app_not_installed';
      const mockFetchToken = jest.fn().mockRejectedValue(error);
      const mockConfigSvc = { getProjectConfig: jest.fn().mockResolvedValue({ projectId: 'test-project' }) };

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:github-token@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(mockConsole.warn).not.toHaveBeenCalled();
    });

    it('retries push on failure and succeeds on second attempt', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      let pushAttempts = 0;
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        if (cmd === 'git push origin HEAD:feature-branch') {
          pushAttempts++;
          if (pushAttempts === 1) throw new Error('Repository not found');
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      githubService.sleep = jest.fn().mockResolvedValue(undefined) as any;

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(pushAttempts).toBe(2);
      expect(mockConsole.log).toHaveBeenCalledWith('Push failed, retrying (1/3)...');
      expect(mockConsole.log).toHaveBeenCalledWith('Changes committed and pushed successfully.');
    });

    it('throws after all retry attempts exhausted', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        if (cmd === 'git push origin HEAD:feature-branch') throw new Error('Repository not found');
        return Buffer.from('');
      });

      githubService.sleep = jest.fn().mockResolvedValue(undefined) as any;

      await expect(githubService.autoCommitChanges('locales/**/*.json')).rejects.toThrow('Repository not found');
      expect(mockConsole.log).toHaveBeenCalledWith('Push failed, retrying (1/3)...');
      expect(mockConsole.log).toHaveBeenCalledWith('Push failed, retrying (2/3)...');
    });
  });

  describe('autoCommitSyncChanges', () => {
    it('does nothing when not in GitHub Actions', async () => {
      mockEnv.GITHUB_ACTIONS = 'false';
      await githubService.autoCommitSyncChanges(['locales/sv.json']);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('commits with sync message including key count, languages and url', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/sv.json');
        if (cmd === 'git log -1 --format=%ae') return Buffer.from('other@example.com');
        return Buffer.from('');
      });

      await githubService.autoCommitSyncChanges(
        ['locales/sv.json'],
        { keysTranslated: 8, languages: ['en', 'fr', 'sv'], viewUrl: 'https://localhero.ai/r/abc123' }
      );

      const expectedMessage = 'Sync translations\n\nSynced 8 keys in en, fr, sv\n\nhttps://localhero.ai/r/abc123';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: 'inherit' });
    });

    it('commits with subject-only when no summary', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/sv.json');
        if (cmd === 'git log -1 --format=%ae') return Buffer.from('other@example.com');
        return Buffer.from('');
      });

      await githubService.autoCommitSyncChanges(['locales/sv.json']);

      expect(mockExec).toHaveBeenCalledWith("git commit -m 'Sync translations'", { stdio: 'inherit' });
    });

    it('stages each modified file and localhero.json', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/sv.json');
        if (cmd === 'git log -1 --format=%ae') return Buffer.from('other@example.com');
        return Buffer.from('');
      });

      await githubService.autoCommitSyncChanges(['locales/sv.json', 'locales/no.json']);

      expect(mockExec).toHaveBeenCalledWith('git add "locales/sv.json"', { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git add "locales/no.json"', { stdio: 'inherit' });
      expect(mockExec).toHaveBeenCalledWith('git add localhero.json', { stdio: 'inherit' });
    });

    it('skips commit when no staged changes', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('');
        return Buffer.from('');
      });

      await githubService.autoCommitSyncChanges(['locales/sv.json']);

      expect(mockConsole.log).toHaveBeenCalledWith('No changes to commit - translations already up to date.');
    });
  });
});
