import { jest } from '@jest/globals';
import { githubService, createGitHubActionFile, autoCommitChanges } from '../../src/utils/github.js';

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
      writeFile: jest.fn().mockResolvedValue(undefined)
    };
    mockPath = {
      join: jest.fn((...args) => args.join('/'))
    };
    mockEnv = {};

    // Reset the service with our mocks
    githubService.setDependencies({
      exec: mockExec,
      fs: mockFs,
      path: mockPath,
      env: mockEnv
    });

    // Mock console methods
    originalConsole = { ...console };
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
    console.info = jest.fn();
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
      expect(fileContent).toContain('name: Localhero.ai - I18n translation');
      expect(fileContent).toContain('- "locales/**/*.json"');
      expect(fileContent).toContain('- "translations/*.yml"');
      expect(fileContent).toContain('run: npx -y @localheroai/cli translate');

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

  describe('autoCommitChanges', () => {
    it('does nothing when not in GitHub Actions', () => {
      mockEnv.GITHUB_ACTIONS = 'false';
      autoCommitChanges('locales/**/*.json');

      expect(mockExec).not.toHaveBeenCalled();
    });

    it('commits and pushes changes when in GitHub Actions and changes exist', () => {
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

      autoCommitChanges('locales/**/*.json');

      // Verify git commands were executed in the correct order
      expect(mockExec).toHaveBeenCalledWith('git config --global user.name "LocalHero Bot"', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git config --global user.email "hi@localhero.ai"', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git add locales/**/*.json', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git status --porcelain');
      expect(mockExec).toHaveBeenCalledWith('git commit -m "Update translations"', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git remote set-url origin https://x-access-token:fake-token@github.com/owner/repo.git', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git push origin HEAD:feature-branch', { stdio: "inherit" });

      // Verify log messages
      expect(console.log).toHaveBeenCalledWith("Running in GitHub Actions. Committing changes...");
      expect(console.log).toHaveBeenCalledWith("Changes committed and pushed successfully.");
    });

    it('does not commit when there are no changes', () => {
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

      autoCommitChanges('locales/**/*.json');

      // Verify git commands were executed but not commit or push
      expect(mockExec).toHaveBeenCalledWith('git add locales/**/*.json', { stdio: "inherit" });
      expect(mockExec).toHaveBeenCalledWith('git status --porcelain');
      expect(mockExec).not.toHaveBeenCalledWith('git commit -m "Update translations"', { stdio: "inherit" });
      expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('git push'), expect.anything());

      // Verify log messages
      expect(console.log).toHaveBeenCalledWith("No changes to commit.");
    });

    it('throws error when branch name is missing', () => {
      // Setup GitHub environment without branch name
      mockEnv.GITHUB_ACTIONS = 'true';
      // GITHUB_HEAD_REF not set

      expect(() => {
        autoCommitChanges('locales/**/*.json');
      }).toThrow('Could not determine branch name from GITHUB_HEAD_REF');
    });

    it('throws error when GitHub token is missing', () => {
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

      expect(() => {
        autoCommitChanges('locales/**/*.json');
      }).toThrow('GITHUB_TOKEN is not set');
    });

    it('throws error when repository is missing', () => {
      // Setup GitHub environment without repository
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      // GITHUB_REPOSITORY not set

      // Mock git status to return changes
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      expect(() => {
        autoCommitChanges('locales/**/*.json');
      }).toThrow('GITHUB_REPOSITORY is not set');
    });

    it('handles git command errors', () => {
      // Setup GitHub environment
      mockEnv.GITHUB_ACTIONS = 'true';
      mockEnv.GITHUB_HEAD_REF = 'feature-branch';
      mockEnv.GITHUB_TOKEN = 'fake-token';
      mockEnv.GITHUB_REPOSITORY = 'owner/repo';

      // Mock git command to throw error
      mockExec.mockImplementation((cmd) => {
        if (cmd === 'git commit -m "Update translations"') {
          throw new Error('Git commit failed');
        }
        if (cmd === 'git status --porcelain') {
          return Buffer.from('M locales/en.json');
        }
        return Buffer.from('');
      });

      expect(() => {
        autoCommitChanges('locales/**/*.json');
      }).toThrow('Git commit failed');

      expect(console.error).toHaveBeenCalledWith('Auto-commit failed:', 'Git commit failed');
    });
  });
});