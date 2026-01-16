import { jest } from '@jest/globals';
import { githubService, createGitHubActionFile, autoCommitChanges, workflowExists, fetchActionToken } from '../../src/utils/github.js';

describe('github module', () => {
  let mockExec;
  let mockFs;
  let mockPath;
  let mockEnv;
  let originalConsole;

  beforeEach(() => {
    mockExec = jest.fn();
    mockFs = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      existsSync: jest.fn().mockReturnValue(false)
    };
    mockPath = {
      join: jest.fn((...args) => args.join('/'))
    };
    mockEnv = {};

    // Mock console methods
    originalConsole = { ...console };
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
    console.info = jest.fn();

    // Reset the service with our mocks (including console for autoCommit methods)
    githubService.setDependencies({
      exec: mockExec,
      fs: mockFs,
      path: mockPath,
      env: mockEnv,
      console: { log: console.log, warn: console.warn, error: console.error }
    });
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  describe('createGitHubActionFile', () => {
    it('creates GitHub action workflow file with correct content', async () => {
      const basePath = '/project';
      const translationPaths = ['locales/**/*.json', 'translations/*.yml'];

      const result = await createGitHubActionFile(basePath, translationPaths);

      // Verify directory was created
      expect(mockFs.mkdir).toHaveBeenCalledWith('/project/.github/workflows', { recursive: true });

      // Verify file path was constructed correctly
      expect(mockPath.join).toHaveBeenCalledWith(basePath, '.github', 'workflows');
      expect(mockPath.join).toHaveBeenCalledWith('/project/.github/workflows', 'localhero-translate.yml');

      // Verify file content
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const fileContent = mockFs.writeFile.mock.calls[0][1];

      expect(fileContent).toContain('name: Localhero.ai - Automatic I18n translation');
      expect(fileContent).toContain('- "locales/**/*.json"');
      expect(fileContent).toContain('- "translations/*.yml"');
      expect(fileContent).toContain('fetch-depth: 0');
      expect(fileContent).toContain('uses: localheroai/localhero-action@v1');
      expect(fileContent).toContain('api-key: ${{ secrets.LOCALHERO_API_KEY }}');

      // Verify return value is the workflow file path
      expect(result).toBe('/project/.github/workflows/localhero-translate.yml');
    });

    it('handles directory paths without patterns correctly', async () => {
      const basePath = '/project';
      const translationPaths = ['locales', 'translations/', 'src/i18n'];

      await createGitHubActionFile(basePath, translationPaths);

      const fileContent = mockFs.writeFile.mock.calls[0][1];
      expect(fileContent).toContain('- "locales/**"');
      expect(fileContent).toContain('- "translations/**"');
      expect(fileContent).toContain('- "src/i18n/**"');
    });

    it('handles mixed paths with and without patterns', async () => {
      const basePath = '/project';
      const translationPaths = ['locales/**/*.{json,yml}', 'translations', 'i18n/*.json'];

      await createGitHubActionFile(basePath, translationPaths);

      const fileContent = mockFs.writeFile.mock.calls[0][1];
      expect(fileContent).toContain('- "locales/**/*.{json,yml}"');
      expect(fileContent).toContain('- "translations/**"');
      expect(fileContent).toContain('- "i18n/*.json"');
    });
  });

  describe('workflowExists', () => {
    it('returns true when workflow file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      const basePath = '/project';

      const result = workflowExists(basePath);

      expect(result).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/project/.github/workflows/localhero-translate.yml');
    });

    it('returns false when workflow file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const basePath = '/project';

      const result = workflowExists(basePath);

      expect(result).toBe(false);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/project/.github/workflows/localhero-translate.yml');
    });
  });

  describe('fetchActionToken', () => {
    let mockFetchGitHubInstallationToken;
    let mockConfigService;

    beforeEach(() => {
      mockFetchGitHubInstallationToken = jest.fn();
      mockConfigService = {
        getProjectConfig: jest.fn()
      };
      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error },
        fetchGitHubInstallationToken: mockFetchGitHubInstallationToken,
        configService: mockConfigService
      });
    });

    it('returns token when backend responds successfully', async () => {
      mockConfigService.getProjectConfig.mockResolvedValue({
        projectId: 'test-project'
      });

      mockFetchGitHubInstallationToken.mockResolvedValue('ghs_test_token_123');

      const result = await fetchActionToken();

      expect(result.token).toBe('ghs_test_token_123');
      expect(result.errorCode).toBeUndefined();
      expect(mockConfigService.getProjectConfig).toHaveBeenCalled();
      expect(mockFetchGitHubInstallationToken).toHaveBeenCalledWith('test-project');
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('returns null with error code when GitHub App not installed (404 error)', async () => {
      mockConfigService.getProjectConfig.mockResolvedValue({
        projectId: 'test-project'
      });

      const error = new Error('GitHub App not installed');
      error.code = 'github_app_not_installed';
      mockFetchGitHubInstallationToken.mockRejectedValue(error);

      const result = await fetchActionToken();

      expect(result.token).toBeNull();
      expect(result.errorCode).toBe('github_app_not_installed');
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('returns null with undefined error code on any unexpected error', async () => {
      mockConfigService.getProjectConfig.mockResolvedValue({
        projectId: 'test-project'
      });

      const error = new Error('Unexpected error');
      mockFetchGitHubInstallationToken.mockRejectedValue(error);

      const result = await fetchActionToken();

      expect(result.token).toBeNull();
      expect(result.errorCode).toBeUndefined();
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('autoCommitChanges', () => {
    it('does nothing when not in GitHub Actions', () => {
      mockEnv.GITHUB_ACTIONS = 'false';
      autoCommitChanges('locales/**/*.json');

      expect(mockExec).not.toHaveBeenCalled();
    });

    it('commits and pushes changes when in GitHub Actions and changes exist', async () => {
      // Setup GitHub environment
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      // Mock git status to return changes
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      // Verify git commands were executed in the correct order
      expect(mockExec).toHaveBeenCalledWith('git config --global user.name "LocalHero Bot"', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git config --global user.email "hi@localhero.ai"', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git add locales/**/*.json', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git status --porcelain');
      expect(mockExec).toHaveBeenCalledWith("git commit -m 'Update translations'", { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git remote set-url origin https://x-access-token:fake-token@github.com/owner/repo.git', { stdio: "pipe" });
      expect(mockExec).toHaveBeenCalledWith('git push origin HEAD:feature-branch', { stdio: "inherit" });

      // Verify log messages
      expect(console.log).toHaveBeenCalledWith("Running in GitHub Actions. Committing changes...");
      expect(console.log).toHaveBeenCalledWith("Changes committed and pushed successfully.");
    });

    it('commits with enhanced message when translation summary is provided', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      const translationSummary = {
        keysTranslated: 15,
        languages: ['German', 'French', 'Spanish'],
        viewUrl: 'https://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ'
      };

      await autoCommitChanges('locales/**/*.json', translationSummary);

      const expectedMessage = 'Update translations\n\nTranslated 15 keys in German, French, Spanish\nView results at https://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: "inherit" });
    });

    it('does not commit when there are no changes', async () => {
      // Setup GitHub environment
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';

      // Mock git status to return no changes
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      // Verify git commands were executed but not commit or push
      expect(mockExec).toHaveBeenCalledWith('git add locales/**/*.json', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git status --porcelain');
      expect(mockExec).not.toHaveBeenCalledWith("git commit -m 'Update translations'", { stdio: "inherit" });
      expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('git push'), expect.anything());

      // Verify log messages
      expect(console.log).toHaveBeenCalledWith("No changes to commit.");
    });

    it('throws error when branch name is missing', async () => {
      // Setup GitHub environment without branch name
      mockEnv.GITHUB_ACTIONS = 'true';
      // GITHUB_HEAD_REF not set

      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('Could not determine branch name from GITHUB_HEAD_REF');
    });

    it('throws error when GitHub token is missing', async () => {
      // Setup GitHub environment without token
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      // GITHUB_TOKEN not set

      // Mock git status to return changes
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('GITHUB_TOKEN is not set');
    });

    it('throws error when repository is missing', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error }
      });
      githubService.sleep = jest.fn().mockResolvedValue(undefined);

      await expect(githubService.autoCommitChanges('locales/**/*.json')).rejects.toThrow('GITHUB_REPOSITORY is not set');
    });

    it('handles git command errors', async () => {
      // Setup GitHub environment
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      // Mock git command to throw error
      mockExec.mockImplementation((cmd) => {
        if (cmd === "git commit -m 'Update translations'") {
          throw new Error('Git commit failed');
        }
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await expect(autoCommitChanges('locales/**/*.json')).rejects.toThrow('Git commit failed');

      expect(console.error).toHaveBeenCalledWith('Auto-commit failed:', 'Git commit failed');
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
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error },
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockFetchToken).toHaveBeenCalledWith('test-project');
      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:ghs_app_token_123@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(console.log).toHaveBeenCalledWith('✓ Using GitHub App token');
      expect(console.warn).not.toHaveBeenCalled();
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
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error },
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockFetchToken).toHaveBeenCalledWith('test-project');
      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:github-token@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(console.warn).toHaveBeenCalledWith(
        '⚠️  Warning: Failed to fetch GitHub App token. Using GITHUB_TOKEN instead (workflows will not trigger).'
      );
    });

    it('silently falls back to GITHUB_TOKEN when GitHub App not installed', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'github-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      const error = new Error('GitHub App not installed');
      error.code = 'github_app_not_installed';
      const mockFetchToken = jest.fn().mockRejectedValue(error);
      const mockConfigSvc = { getProjectConfig: jest.fn().mockResolvedValue({ projectId: 'test-project' }) };

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error },
        fetchGitHubInstallationToken: mockFetchToken,
        configService: mockConfigSvc
      });

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(mockExec).toHaveBeenCalledWith(
        'git remote set-url origin https://x-access-token:github-token@github.com/owner/repo.git',
        { stdio: 'pipe' }
      );
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Changes committed and pushed successfully.');
    });

    it('retries push on failure and succeeds on second attempt', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      let pushAttempts = 0;
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        if (cmd === 'git push origin HEAD:feature-branch') {
          pushAttempts++;
          if (pushAttempts === 1) {
            throw new Error('Repository not found');
          }
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error }
      });
      githubService.sleep = jest.fn().mockResolvedValue(undefined);

      await githubService.autoCommitChanges('locales/**/*.json');

      expect(pushAttempts).toBe(2);
      expect(console.log).toHaveBeenCalledWith('Push failed, retrying (1/3)...');
      expect(console.log).toHaveBeenCalledWith('Changes committed and pushed successfully.');
    });

    it('throws after all retry attempts exhausted', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        if (cmd === 'git push origin HEAD:feature-branch') {
          throw new Error('Repository not found');
        }
        return Buffer.from('');
      });

      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs,
        path: mockPath,
        env: mockEnv,
        console: { log: console.log, warn: console.warn, error: console.error }
      });
      githubService.sleep = jest.fn().mockResolvedValue(undefined);

      await expect(githubService.autoCommitChanges('locales/**/*.json')).rejects.toThrow('Repository not found');

      expect(console.log).toHaveBeenCalledWith('Push failed, retrying (1/3)...');
      expect(console.log).toHaveBeenCalledWith('Push failed, retrying (2/3)...');
    });
  });
});
