import { execSync, ExecSyncOptions } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { fetchGitHubInstallationToken } from '../api/github.js';
import { configService, PROJECT_CONFIG_FILE } from './config.js';
import { CommitSummary } from '../types/index.js';

/**
 * Dependencies for the GitHub service
 */
interface GitHubDependencies {
  exec: (cmd: string, options?: ExecSyncOptions) => Buffer | string;
  fs: typeof fs & { existsSync: typeof existsSync };
  path: typeof path;
  env: NodeJS.ProcessEnv;
  console: Pick<Console, 'log' | 'warn' | 'error'>;
  fetchGitHubInstallationToken?: (projectId: string) => Promise<string>;
  configService?: {
    getProjectConfig: (basePath?: string) => Promise<any>;
  };
  [key: string]: unknown;
}

const defaultDependencies: GitHubDependencies = {
  exec: (cmd: string, options?: ExecSyncOptions) => execSync(cmd, options),
  fs: { ...fs, existsSync },
  path,
  env: process.env,
  console,
  fetchGitHubInstallationToken,
  configService
};

const workflowFileName = 'localhero-translate.yml';
const GIT_USER_NAME = 'LocalHero Bot';
const GIT_USER_EMAIL = 'hi@localhero.ai';

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
      - "localhero.json"
  workflow_dispatch:

concurrency:
  group: translate-\${{ github.head_ref || github.run_id }}
  cancel-in-progress: true

jobs:
  translate:
    if: |
      !contains(github.event.pull_request.labels.*.name, 'skip-translation') &&
      github.event.pull_request.draft == false &&
      !(github.actor == 'localhero-ai[bot]' && github.event.action == 'synchronize')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
    - name: Checkout code
      uses: actions/checkout@v5
      with:
        ref: \${{ github.head_ref }}
        fetch-depth: 0

    - name: Fetch base branch for comparison
      if: github.event_name == 'pull_request'
      run: |
        git fetch --no-tags origin \${{ github.base_ref }}

    - name: Set up Node.js
      uses: actions/setup-node@v5
      with:
        node-version: 22

    - name: Translate strings
      env:
        LOCALHERO_API_KEY: \${{ secrets.LOCALHERO_API_KEY }}
        GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        GITHUB_BASE_REF: \${{ github.base_ref }}
      run: npx -y @localheroai/cli ci`;

    await fs.writeFile(workflowFile, actionContent);
    return workflowFile;
  },

  async fetchActionToken(): Promise<{ token: string | null; errorCode?: string }> {
    try {
      const config = await this.deps.configService!.getProjectConfig();
      const token = await this.deps.fetchGitHubInstallationToken!(config.projectId);
      return { token };

    } catch (error: unknown) {
      const err = error as Error & { code?: string };
      return { token: null, errorCode: err.code };
    }
  },

  /**
   * Configure git user for commits
   */
  configureGitUser(): void {
    const { exec } = this.deps;
    exec(`git config --global user.name "${GIT_USER_NAME}"`, { stdio: 'inherit' });
    exec(`git config --global user.email "${GIT_USER_EMAIL}"`, { stdio: 'inherit' });
  },

  /**
   * Get the current branch name from GitHub Actions environment
   */
  getBranchName(): string {
    const branchName = this.deps.env.GITHUB_HEAD_REF;
    if (!branchName) {
      throw new Error('Could not determine branch name from GITHUB_HEAD_REF');
    }
    return branchName;
  },

  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  async pushWithRetry(
    branchName: string,
    token: string,
    forceWithLease: boolean = false,
    maxRetries: number = 3
  ): Promise<void> {
    const { console: log } = this.deps;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.pushToGitHub(branchName, token, forceWithLease);
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        log.log(`Push failed, retrying (${attempt}/${maxRetries})...`);
        await this.sleep(2000);
      }
    }
  },

  /**
   * Push changes to GitHub using the provided token
   * @param branchName Branch to push to
   * @param token GitHub token for authentication
   * @param forceWithLease Use --force-with-lease for amended commits
   */
  pushToGitHub(branchName: string, token: string, forceWithLease: boolean = false): void {
    const { exec, env, console: log } = this.deps;

    const repository = env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY is not set');
    }

    const remoteUrl = `https://x-access-token:${token}@github.com/${repository}.git`;

    try {
      const result = exec(`git remote set-url origin ${remoteUrl}`, { stdio: 'pipe' });
      if (result) {
        const maskedOutput = result.toString().replace(token, '***TOKEN***');
        if (maskedOutput.trim()) {
          log.log(maskedOutput);
        }
      }
    } catch (error: unknown) {
      const err = error as Error;
      const maskedMessage = err.message.replace(token, '***TOKEN***');
      throw new Error(maskedMessage);
    }

    const pushCmd = forceWithLease
      ? `git push --force-with-lease origin HEAD:${branchName}`
      : `git push origin HEAD:${branchName}`;
    exec(pushCmd, { stdio: 'inherit' });
  },

  /**
   * Check if there are staged changes to commit
   */
  hasStagedChanges(): boolean {
    const { exec } = this.deps;
    const status = exec('git status --porcelain').toString();
    return status.length > 0;
  },

  /**
   * Check if the last commit was made by LocalHero bot
   * Used to determine if we can safely amend the commit
   */
  isLastCommitByLocalHero(): boolean {
    const { exec } = this.deps;
    try {
      const authorEmail = exec('git log -1 --format=%ae').toString().trim();
      return authorEmail.includes('localhero');
    } catch {
      return false;
    }
  },

  /**
   * Commit with the given message
   * @param message Commit message
   * @param amend Whether to amend the previous commit
   */
  commit(message: string, amend: boolean = false): void {
    const { exec } = this.deps;
    const escapedMessage = message.replace(/'/g, "'\\''");
    const commitCmd = amend
      ? `git commit --amend -m '${escapedMessage}'`
      : `git commit -m '${escapedMessage}'`;
    exec(commitCmd, { stdio: 'inherit' });
  },

  /**
   * Get the token to use for pushing, preferring GitHub App token if available
   */
  async getTokenForPush(): Promise<string> {
    const { env, console: log } = this.deps;

    const { token: appToken, errorCode } = await this.fetchActionToken();
    const finalToken = appToken || env.GITHUB_TOKEN;

    if (!finalToken) {
      throw new Error('GITHUB_TOKEN is not set');
    }

    if (appToken) {
      log.log('✓ Using GitHub App token');
    } else {
      if (errorCode === 'invalid_api_key') {
        log.warn('⚠️  Warning: API authentication failed. Using GITHUB_TOKEN instead (workflows will not trigger).');
      } else if (errorCode !== 'github_app_not_installed') {
        log.warn('⚠️  Warning: Failed to fetch GitHub App token. Using GITHUB_TOKEN instead (workflows will not trigger).');
      }
    }

    return finalToken;
  },

  /**
   * Automatically commit and push sync changes when running in GitHub Actions
   * @param modifiedFiles List of file paths that were modified
   * @param syncSummary Optional summary of sync results
   */
  async autoCommitSyncChanges(modifiedFiles: string[], syncSummary?: CommitSummary): Promise<void> {
    const { exec, console: log } = this.deps;

    if (!this.isGitHubAction()) return;

    log.log('\nCommitting sync changes...');
    try {
      this.configureGitUser();
      const branchName = this.getBranchName();

      let commitMessage = 'Sync translations from LocalHero.ai';

      if (syncSummary && syncSummary.keysTranslated > 0) {
        const { keysTranslated, languages, viewUrl } = syncSummary;
        const languageList = languages.join(', ');

        if (keysTranslated > 1) {
          commitMessage += `\n\nSynced ${keysTranslated} keys in ${languageList}`;
        } else {
          commitMessage += `\n\nSynced ${keysTranslated} key in ${languageList}`;
        }

        if (viewUrl) {
          commitMessage += `\nView results at ${viewUrl}`;
        }
      }

      for (const filePath of modifiedFiles) {
        exec(`git add "${filePath}"`, { stdio: 'inherit' });
      }
      exec(`git add ${PROJECT_CONFIG_FILE}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit.');
        return;
      }

      // Only amend if last commit was by LocalHero bot - don't amend other developers' commits
      const canAmend = this.isLastCommitByLocalHero();
      this.commit(commitMessage, canAmend);

      const token = await this.getTokenForPush();
      await this.pushWithRetry(branchName, token, canAmend);

      if (canAmend) {
        log.log('✓ Commit amended and pushed to GitHub\n');
      } else {
        log.log('✓ New commit created and pushed to GitHub\n');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Auto-commit failed:', errorMessage);
      throw error;
    }
  },

  /**
   * Automatically commit and push changes when running in GitHub Actions
   * @param filesPath Path pattern for files to commit
   * @param translationSummary Optional summary of translation results
   */
  async autoCommitChanges(filesPath: string, translationSummary?: CommitSummary): Promise<void> {
    const { exec, console: log } = this.deps;

    if (!this.isGitHubAction()) return;

    log.log('Running in GitHub Actions. Committing changes...');
    try {
      this.configureGitUser();
      const branchName = this.getBranchName();

      exec(`git add ${filesPath}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit.');
        return;
      }

      let commitMessage = 'Update translations';

      if (translationSummary && translationSummary.keysTranslated > 0) {
        const { keysTranslated, languages, viewUrl } = translationSummary;
        const languageList = languages.join(', ');

        if (keysTranslated > 1) {
          commitMessage += `\n\nTranslated ${keysTranslated} keys in ${languageList}`;
        } else {
          commitMessage += `\n\nTranslated ${keysTranslated} key in ${languageList}`;
        }

        if (viewUrl) {
          commitMessage += `\nView results at ${viewUrl}`;
        }
      }

      this.commit(commitMessage);

      const token = await this.getTokenForPush();
      await this.pushWithRetry(branchName, token);

      log.log('Changes committed and pushed successfully.');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Auto-commit failed:', errorMessage);
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
 * Fetch GitHub App installation token from backend
 * @returns Object with token (string or null) and optional errorCode
 */
export function fetchActionToken(): Promise<{ token: string | null; errorCode?: string }> {
  return githubService.fetchActionToken();
}

/**
 * Automatically commit and push changes when running in GitHub Actions
 * @param filesPath Path pattern for files to commit
 * @param translationSummary Optional summary of translation results
 */
export function autoCommitChanges(filesPath: string, translationSummary?: CommitSummary): Promise<void> {
  return githubService.autoCommitChanges(filesPath, translationSummary);
}
