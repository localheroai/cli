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
      expect(fileContent).toContain('repository_dispatch:');
      expect(fileContent).toContain('types: [localhero-sync]');
      expect(fileContent).toContain('workflow_dispatch:');
      expect(fileContent).toContain('ref: ${{ github.event.client_payload.branch || github.head_ref || github.ref_name }}');
      expect(fileContent).toContain('group: translate-${{ github.event.client_payload.branch || github.head_ref || github.run_id }}');
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

    it('writes sourceCodePaths as literal patterns without brace expansion', async () => {
      const sourceCodePaths = ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.jsx'];
      await createGitHubActionFile('/project', ['src/locales/**'], sourceCodePaths);

      const fileContent = (mockFs.writeFile.mock.calls[0] as unknown[])[1] as string;
      expect(fileContent).toContain('- "src/**/*.ts"');
      expect(fileContent).toContain('- "src/**/*.tsx"');
      expect(fileContent).toContain('- "src/**/*.js"');
      expect(fileContent).toContain('- "src/**/*.jsx"');
      expect(fileContent).not.toContain('{ts,tsx');
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
        languages: ['de', 'fr', 'es'],
        viewUrl: 'https://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ'
      });

      const expectedMessage = 'Update translations\n\n15 keys in de, fr, es\n\nhttps://localhero.ai/r/QfH8nfDs5IHqfcxDYjFCJ';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: 'inherit' });
    });

    it('includes co-author trailer when GITHUB_ACTOR is set', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';
      mockEnv.GITHUB_ACTOR = 'arvida';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      const expectedMessage = 'Update translations\n\nCo-authored-by: arvida <arvida@users.noreply.github.com>';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: 'inherit' });
    });

    it('includes co-author trailer with translation summary', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';
      mockEnv.GITHUB_ACTOR = 'arvida';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json', {
        keysTranslated: 5,
        languages: ['de', 'fr'],
        viewUrl: 'https://localhero.ai/r/abc123'
      });

      const expectedMessage = 'Update translations\n\n5 keys in de, fr\n\nhttps://localhero.ai/r/abc123\n\nCo-authored-by: arvida <arvida@users.noreply.github.com>';
      expect(mockExec).toHaveBeenCalledWith(`git commit -m '${expectedMessage}'`, { stdio: 'inherit' });
    });

    it('skips co-author trailer when GITHUB_ACTOR is a bot', async () => {
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';
      mockEnv.GITHUB_ACTOR = 'dependabot[bot]';

      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from('M locales/en.json');
        return Buffer.from('');
      });

      await autoCommitChanges('locales/**/*.json');

      expect(mockExec).toHaveBeenCalledWith("git commit -m 'Update translations'", { stdio: 'inherit' });
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

      const expectedMessage = 'Sync translations\n\n8 keys in en, fr, sv\n\nhttps://localhero.ai/r/abc123';
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

  describe('signed-commits mode', () => {
    let mockCreateSignedCommit: jest.Mock;
    let mockFetchBranchHead: jest.Mock;
    let mockReadFile: jest.Mock;
    let mockExistsSync: jest.Mock;

    beforeEach(() => {
      mockCreateSignedCommit = jest.fn();
      mockFetchBranchHead = jest.fn();
      mockReadFile = jest.fn();
      mockExistsSync = jest.fn().mockReturnValue(true);

      const mockConfigSvc = {
        getProjectConfig: jest.fn().mockResolvedValue({
          projectId: 'proj_test',
          github: { signedCommits: true }
        })
      };

      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_REPOSITORY = 'localheroai/test-repo';
      mockEnv.GITHUB_TOKEN = 'token-fallback';

      githubService.setDependencies({
        exec: mockExec,
        fs: { ...mockFs, readFile: mockReadFile, existsSync: mockExistsSync } as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        configService: mockConfigSvc as any,
        fetchGitHubInstallationToken: jest.fn().mockResolvedValue('ghs_app_token') as any,
        createSignedCommit: mockCreateSignedCommit as any,
        fetchBranchHead: mockFetchBranchHead as any
      });
    });

    it('uses GraphQL path when github.signedCommits is true', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockReadFile.mockResolvedValue(Buffer.from('sv:\n  hello: hej'));
      mockFetchBranchHead.mockResolvedValue({
        sha: 'a'.repeat(40),
        parentSha: 'b'.repeat(40),
        authorEmail: 'developer@example.com'
      });
      mockCreateSignedCommit.mockResolvedValue({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

      await githubService.autoCommitSyncChanges(
        ['locales/sv.yml'],
        { keysTranslated: 5, languages: ['sv'] }
      );

      expect(mockCreateSignedCommit).toHaveBeenCalledTimes(1);
      const call = mockCreateSignedCommit.mock.calls[0][0] as any;
      expect(call.repositoryNameWithOwner).toBe('localheroai/test-repo');
      expect(call.branchName).toBe('feature-branch');
      expect(call.expectedHeadOid).toBe('a'.repeat(40));
      expect(call.fileChanges.additions).toHaveLength(2); // sv.yml + localhero.json
      expect(call.fileChanges.additions[0].path).toBe('locales/sv.yml');
      expect(call.fileChanges.additions[0].contents).toBe(Buffer.from('sv:\n  hello: hej').toString('base64'));
      expect(call.message.headline).toBe('Sync translations');
      expect(call.token).toBe('ghs_app_token');
      expect(mockConsole.log).toHaveBeenCalledWith('✓ Signed commit created and pushed to GitHub\n');
    });

    it('uses parent SHA as expectedHeadOid when amending LocalHero bot commit', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockReadFile.mockResolvedValue(Buffer.from('content'));
      mockFetchBranchHead.mockResolvedValue({
        sha: 'a'.repeat(40),
        parentSha: 'b'.repeat(40),
        authorEmail: '233842311+localhero-ai[bot]@users.noreply.github.com'
      });
      mockCreateSignedCommit.mockResolvedValue({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

      await githubService.autoCommitSyncChanges(['locales/sv.yml']);

      const call = mockCreateSignedCommit.mock.calls[0][0] as any;
      expect(call.expectedHeadOid).toBe('b'.repeat(40));
      expect(mockConsole.log).toHaveBeenCalledWith('✓ Commit amended and pushed to GitHub (signed)\n');
    });

    it('does not amend when the last commit is not by LocalHero bot', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockReadFile.mockResolvedValue(Buffer.from('content'));
      mockFetchBranchHead.mockResolvedValue({
        sha: 'a'.repeat(40),
        parentSha: 'b'.repeat(40),
        authorEmail: 'human@example.com'
      });
      mockCreateSignedCommit.mockResolvedValue({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

      await githubService.autoCommitSyncChanges(['locales/sv.yml']);

      const call = mockCreateSignedCommit.mock.calls[0][0] as any;
      expect(call.expectedHeadOid).toBe('a'.repeat(40));
    });

    it('skips commit when no files exist on disk', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockExistsSync.mockReturnValue(false);

      await githubService.autoCommitSyncChanges(['nonexistent.yml']);

      expect(mockCreateSignedCommit).not.toHaveBeenCalled();
      expect(mockFetchBranchHead).not.toHaveBeenCalled();
      expect(mockConsole.log).toHaveBeenCalledWith('No changes to commit - translations already up to date.');
    });

    it('retries on stale head error', async () => {
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockReadFile.mockResolvedValue(Buffer.from('content'));
      mockFetchBranchHead
        .mockResolvedValueOnce({ sha: 'a'.repeat(40), parentSha: 'b'.repeat(40), authorEmail: null })
        .mockResolvedValueOnce({ sha: 'd'.repeat(40), parentSha: 'b'.repeat(40), authorEmail: null });

      // Import the error class lazily to avoid top-level imports in test file
      const { StaleHeadError } = await import('../../src/utils/github-graphql.js');
      mockCreateSignedCommit
        .mockRejectedValueOnce(new StaleHeadError('Branch advanced'))
        .mockResolvedValueOnce({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

      await githubService.autoCommitSyncChanges(['locales/sv.yml']);

      expect(mockCreateSignedCommit).toHaveBeenCalledTimes(2);
      expect(mockFetchBranchHead).toHaveBeenCalledTimes(2);
    });

    it('falls through to shell path when signedCommits flag is false', async () => {
      const mockConfigSvcOff = {
        getProjectConfig: jest.fn().mockResolvedValue({
          projectId: 'proj_test',
          github: { signedCommits: false }
        })
      };
      githubService.setDependencies({
        exec: mockExec,
        fs: mockFs as any,
        path: mockPath as any,
        env: mockEnv,
        console: mockConsole,
        configService: mockConfigSvcOff as any,
        fetchGitHubInstallationToken: jest.fn().mockResolvedValue('ghs_app_token') as any,
        createSignedCommit: mockCreateSignedCommit as any,
        fetchBranchHead: mockFetchBranchHead as any
      });

      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return Buffer.from(' M locales/sv.yml\n');
        if (cmd === 'git log -1 --format=%ae') return Buffer.from('developer@example.com\n');
        return Buffer.from('');
      });

      await githubService.autoCommitSyncChanges(['locales/sv.yml']);

      expect(mockCreateSignedCommit).not.toHaveBeenCalled();
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git config --global user.name'), expect.anything());
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git commit'), expect.anything());
    });

    describe('autoCommitChanges (translate flow)', () => {
      it('uses GraphQL path with files scoped by the caller-provided pattern', async () => {
        mockEnv.GITHUB_HEAD_REF = 'feature-branch';
        mockExec.mockImplementation((cmd: string) => {
          if (cmd.startsWith('git ls-files')) {
            // ls-files -z output is NUL-delimited, no trailing newline
            return Buffer.from('locales/sv.yml\0locales/nb.yml\0');
          }
          return Buffer.from('');
        });
        mockReadFile.mockResolvedValue(Buffer.from('content'));
        mockFetchBranchHead.mockResolvedValue({
          sha: 'a'.repeat(40),
          parentSha: 'b'.repeat(40),
          authorEmail: null
        });
        mockCreateSignedCommit.mockResolvedValue({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

        await githubService.autoCommitChanges('locales/', {
          keysTranslated: 3,
          languages: ['sv', 'nb']
        });

        const call = mockCreateSignedCommit.mock.calls[0][0] as any;
        expect(call.fileChanges.additions).toHaveLength(2);
        expect(call.fileChanges.additions.map((a: any) => a.path).sort()).toEqual(['locales/nb.yml', 'locales/sv.yml']);
        expect(call.message.headline).toBe('Update translations');
        expect(call.message.body).toContain('3 keys in sv, nb');

        // Confirm the ls-files command included the caller-provided pattern so
        // we don't pick up unrelated working-tree files (regression: previous
        // implementation used `git status --porcelain` with no scope).
        const lsFilesCall = mockExec.mock.calls.find(([cmd]: any) => typeof cmd === 'string' && cmd.startsWith('git ls-files'));
        expect(lsFilesCall?.[0]).toContain('-- locales/');
      });

      it('handles paths with spaces correctly (NUL-delimited ls-files output)', async () => {
        mockEnv.GITHUB_HEAD_REF = 'feature-branch';
        mockExec.mockImplementation((cmd: string) => {
          if (cmd.startsWith('git ls-files')) {
            return Buffer.from('locales/sv nb.yml\0');
          }
          return Buffer.from('');
        });
        mockReadFile.mockResolvedValue(Buffer.from('content'));
        mockFetchBranchHead.mockResolvedValue({
          sha: 'a'.repeat(40),
          parentSha: 'b'.repeat(40),
          authorEmail: null
        });
        mockCreateSignedCommit.mockResolvedValue({ commitSha: 'c'.repeat(40), commitUrl: 'https://github.com/...' });

        await githubService.autoCommitChanges('locales/');

        const call = mockCreateSignedCommit.mock.calls[0][0] as any;
        expect(call.fileChanges.additions).toEqual([
          { path: 'locales/sv nb.yml', contents: Buffer.from('content').toString('base64') }
        ]);
      });
    });
  });
});
