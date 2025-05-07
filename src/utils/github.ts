import { execSync, ExecSyncOptions } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';

/**
 * Dependencies for the GitHub service
 */
interface GitHubDependencies {
  exec: (cmd: string, options?: ExecSyncOptions) => Buffer | string;
  fs: typeof fs & { existsSync: typeof existsSync };
  path: typeof path;
  env: NodeJS.ProcessEnv;
  [key: string]: unknown;
}

const defaultDependencies: GitHubDependencies = {
  exec: (cmd: string, options?: ExecSyncOptions) => execSync(cmd, options),
  fs: { ...fs, existsSync },
  path,
  env: process.env
};

const workflowFileName = 'localhero-translate.yml';

export const githubService = {
  deps: { ...defaultDependencies },

  /**
   * For testing - reset or inject custom dependencies
   */
  setDependencies(customDeps: Partial<GitHubDependencies> = {}): typeof githubService {
    this.deps = { ...defaultDependencies, ...customDeps };
    return this;
  },

  /**
   * Check if running in GitHub Actions
   */
  isGitHubAction(): boolean {
    return this.deps.env.GITHUB_ACTIONS === 'true';
  },

  /**
   * Check if the GitHub workflow file exists
   * @param basePath Base path of the project
   */
  workflowExists(basePath: string): boolean {
    return this.deps.fs.existsSync(this.getGithubActionWorkflowFilePath(basePath));
  },

  /**
   * Get the workflows directory path
   * @param basePath Base path of the project
   */
  getWorkflowDir(basePath: string): string {
    return this.deps.path.join(basePath, '.github', 'workflows');
  },

  /**
   * Get the full path to the GitHub action workflow file
   * @param basePath Base path of the project
   */
  getGithubActionWorkflowFilePath(basePath: string): string {
    return this.deps.path.join(this.getWorkflowDir(basePath), workflowFileName);
  },

  /**
   * Create a GitHub actions workflow file for translations
   * @param basePath Base path of the project
   * @param translationPaths Paths to translation files
   */
  async createGitHubActionFile(basePath: string, translationPaths: string[]): Promise<string> {
    const { fs } = this.deps;
    const workflowDir = this.getWorkflowDir(basePath);
    const workflowFile = this.getGithubActionWorkflowFilePath(basePath);

    await fs.mkdir(workflowDir, { recursive: true });

    const actionContent = `name: Localhero.ai - Automatic I18n translation

on:
  pull_request:
    paths:
      ${translationPaths.map(p => {
    // Check if path already contains a file pattern (*, ?, or {})
    const hasPattern = /[*?{}]/.test(p);
    // If it has a pattern, use it as is; otherwise, append /**
    const formattedPath = hasPattern ? p : `${p}${p.endsWith('/') ? '' : '/'}**`;
    return `- "${formattedPath}"`;
  }).join('\n      ')}

jobs:
  translate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
    - name: Checkout code
      uses: actions/checkout@v4
      with:
        ref: \${{ github.head_ref }}

    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 22

    - name: Run LocalHero CLI
      env:
        LOCALHERO_API_KEY: \${{ secrets.LOCALHERO_API_KEY }}
        GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      run: npx -y @localheroai/cli translate`;

    await fs.writeFile(workflowFile, actionContent);
    return workflowFile;
  },

  /**
   * Automatically commit and push changes when running in GitHub Actions
   * @param filesPath Path pattern for files to commit
   */
  autoCommitChanges(filesPath: string): void {
    const { exec, env } = this.deps;

    if (!this.isGitHubAction()) return;

    console.log('Running in GitHub Actions. Committing changes...');
    try {
      exec('git config --global user.name "LocalHero Bot"', { stdio: 'inherit' });
      exec('git config --global user.email "hi@localhero.ai"', { stdio: 'inherit' });

      const branchName = env.GITHUB_HEAD_REF;
      if (!branchName) {
        throw new Error('Could not determine branch name from GITHUB_HEAD_REF');
      }

      exec(`git add ${filesPath}`, { stdio: 'inherit' });

      const status = exec('git status --porcelain').toString();
      if (!status) {
        console.log('No changes to commit.');
        return;
      }

      exec('git commit -m "Update translations"', { stdio: 'inherit' });

      const token = env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN is not set');
      }

      const repository = env.GITHUB_REPOSITORY;
      if (!repository) {
        throw new Error('GITHUB_REPOSITORY is not set');
      }

      const remoteUrl = `https://x-access-token:${token}@github.com/${repository}.git`;

      exec(`git remote set-url origin ${remoteUrl}`, { stdio: 'inherit' });
      exec(`git push origin HEAD:${branchName}`, { stdio: 'inherit' });
      console.log('Changes committed and pushed successfully.');
    } catch (error: any) {
      console.error('Auto-commit failed:', error.message);
      throw error;
    }
  }
};

/**
 * Create a GitHub actions workflow file for translations
 * @param basePath Base path of the project
 * @param translationPaths Paths to translation files
 */
export function createGitHubActionFile(basePath: string, translationPaths: string[]): Promise<string> {
  return githubService.createGitHubActionFile(basePath, translationPaths);
}

/**
 * Check if the GitHub workflow file exists
 * @param basePath Base path of the project
 */
export function workflowExists(basePath: string): boolean {
  return githubService.workflowExists(basePath);
}

/**
 * Automatically commit and push changes when running in GitHub Actions
 * @param filesPath Path pattern for files to commit
 */
export function autoCommitChanges(filesPath: string): void {
  return githubService.autoCommitChanges(filesPath);
}