import { execSync, ExecSyncOptions } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { fetchGitHubInstallationToken } from '../api/github.js';
import { configService, PROJECT_CONFIG_FILE } from './config.js';
import { CommitSummary, ProjectConfig } from '../types/index.js';
import {
  createSignedCommit,
  fetchBranchHead,
  StaleHeadError,
  CreateCommitInput,
  CreateCommitResult,
  BranchHead
} from './github-graphql.js';

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
    getProjectConfig: (basePath?: string) => Promise<ProjectConfig | null>;
  };
  createSignedCommit?: (input: CreateCommitInput) => Promise<CreateCommitResult>;
  fetchBranchHead?: (repo: string, branch: string, token: string) => Promise<BranchHead>;
  [key: string]: unknown;
}

const defaultDependencies: GitHubDependencies = {
  exec: (cmd: string, options?: ExecSyncOptions) => execSync(cmd, options),
  fs: { ...fs, existsSync },
  path,
  env: process.env,
  console,
  fetchGitHubInstallationToken,
  configService,
  createSignedCommit,
  fetchBranchHead
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
  async createGitHubActionFile(basePath: string, translationPaths: string[], sourceCodePaths?: string[]): Promise<string> {
    const { fs } = this.deps;
    const workflowDir = this.getWorkflowDir(basePath);
    const workflowFile = this.getGithubActionWorkflowFilePath(basePath);

    await fs.mkdir(workflowDir, { recursive: true });

    const translationPathEntries = translationPaths.map(p => {
      const hasPattern = /[*?{}]/.test(p);
      const formattedPath = hasPattern ? p : `${p}${p.endsWith('/') ? '' : '/'}**`;
      return `- "${formattedPath}"`;
    });
    // GitHub Actions paths: filter does not support brace expansion ({a,b}).
    // Patterns must already be expanded to one entry per extension.
    const sourceCodePathEntries = (sourceCodePaths || []).map(p => `- "${p}"`);
    const allPathEntries = [...translationPathEntries, ...sourceCodePathEntries, '- "localhero.json"'];

    const actionContent = `name: Localhero.ai - Automatic I18n translation

on:
  pull_request:
    paths:
      ${allPathEntries.join('\n      ')}
  repository_dispatch:
    types: [localhero-sync]
  workflow_dispatch:

concurrency:
  group: translate-\${{ github.event.client_payload.branch || github.head_ref || github.run_id }}
  cancel-in-progress: true

jobs:
  translate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v5
        with:
          ref: \${{ github.event.client_payload.branch || github.head_ref || github.ref_name }}
          fetch-depth: 0

      - name: Translate
        uses: localheroai/localhero-action@v1
        with:
          api-key: \${{ secrets.LOCALHERO_API_KEY }}`;

    await fs.writeFile(workflowFile, actionContent);
    return workflowFile;
  },

  async fetchActionToken(): Promise<{ token: string | null; errorCode?: string }> {
    try {
      const config = await this.deps.configService!.getProjectConfig();
      if (!config) {
        return { token: null, errorCode: 'config_missing' };
      }
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

  canAmendLastCommit(isSyncMode: boolean): boolean {
    if (!isSyncMode) return false;
    const { exec } = this.deps;
    try {
      const authorEmail = exec('git log -1 --format=%ae').toString().trim();
      if (!authorEmail.includes('localhero')) return false;
      const diff = exec('git log -1 --format= -p -- localhero.json').toString();
      return diff.includes('syncTriggerId');
    } catch {
      return false;
    }
  },

  buildSyncCommitMessage(summary?: CommitSummary): string {
    const lines = ['Sync translations'];

    if (summary?.keysTranslated && summary.languages?.length) {
      const keyWord = summary.keysTranslated === 1 ? 'key' : 'keys';
      lines.push(`${summary.keysTranslated} ${keyWord} in ${summary.languages.join(', ')}`);
    }

    if (summary?.viewUrl) {
      lines.push(summary.viewUrl);
    }

    return lines.join('\n\n');
  },

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
   * Resolve the project's config and return whether signed-commits mode is on.
   * Falls back to false on any error so the existing flow stays the default.
   */
  async useSignedCommitsMode(): Promise<boolean> {
    try {
      const cfg = await this.deps.configService!.getProjectConfig();
      return Boolean(cfg?.github?.signedCommits);
    } catch {
      return false;
    }
  },

  /**
   * Automatically commit and push sync changes when running in GitHub Actions
   * @param modifiedFiles List of file paths that were modified
   * @param syncSummary Optional summary of sync results
   */
  async autoCommitSyncChanges(
    modifiedFiles: string[],
    syncSummary?: CommitSummary,
    options?: { branchName?: string }
  ): Promise<void> {
    const { exec, console: log } = this.deps;

    if (!this.isGitHubAction()) return;

    log.log('\nCommitting sync changes...');
    try {
      const branchName = options?.branchName || this.getBranchName();
      const commitMessage = this.buildSyncCommitMessage(syncSummary);

      if (await this.useSignedCommitsMode()) {
        const filesToCommit = [...modifiedFiles, PROJECT_CONFIG_FILE];
        const result = await this.apiCommitAndPush({
          branchName,
          filePaths: filesToCommit,
          message: commitMessage,
          isSyncMode: true
        });
        if (result === 'no-changes') {
          log.log('No changes to commit - translations already up to date.');
        } else if (result === 'amended') {
          log.log('✓ Commit amended and pushed to GitHub (signed)\n');
        } else {
          log.log('✓ Signed commit created and pushed to GitHub\n');
        }
        return;
      }

      this.configureGitUser();

      for (const filePath of modifiedFiles) {
        exec(`git add "${filePath}"`, { stdio: 'inherit' });
      }
      exec(`git add ${PROJECT_CONFIG_FILE}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit - translations already up to date.');
        return;
      }

      const canAmend = this.canAmendLastCommit(true);
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
   * Build the commit message used by autoCommitChanges, including optional
   * Co-authored-by trailer derived from GITHUB_ACTOR.
   */
  buildTranslateCommitMessage(translationSummary?: CommitSummary): string {
    let commitMessage = 'Update translations';

    if (translationSummary && translationSummary.keysTranslated > 0) {
      const { keysTranslated, languages, viewUrl } = translationSummary;
      const languageList = languages.join(', ');

      commitMessage += `\n\n${keysTranslated} ${keysTranslated > 1 ? 'keys' : 'key'} in ${languageList}`;

      if (viewUrl) {
        commitMessage += `\n\n${viewUrl}`;
      }
    }

    const actor = this.deps.env.GITHUB_ACTOR;
    if (actor && !actor.includes('[bot]')) {
      commitMessage += `\n\nCo-authored-by: ${actor} <${actor}@users.noreply.github.com>`;
    }

    return commitMessage;
  },

  /**
   * Enumerate files in the working tree that differ from HEAD. Used by the
   * signed-commits path to know which files to send to the GraphQL API.
   * Returns repo-relative paths.
   */
  listChangedFiles(filesPath?: string): string[] {
    const { exec } = this.deps;
    // `ls-files --modified --others --exclude-standard` mirrors what `git add .`
    // would stage: tracked-and-modified plus untracked-but-not-ignored. -z gives
    // NUL-delimited output so paths with spaces or special characters round-trip
    // intact (no quoting, no rename arrows, no escaping).
    const command = filesPath
      ? `git ls-files --modified --others --exclude-standard -z -- ${filesPath}`
      : 'git ls-files --modified --others --exclude-standard -z';
    const output = exec(command, { stdio: 'pipe' }).toString();
    return output.split('\0').filter(line => line.length > 0);
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
      const branchName = this.getBranchName();
      const commitMessage = this.buildTranslateCommitMessage(translationSummary);

      if (await this.useSignedCommitsMode()) {
        const filePaths = this.listChangedFiles(filesPath);
        const result = await this.apiCommitAndPush({
          branchName,
          filePaths,
          message: commitMessage,
          isSyncMode: false
        });
        if (result === 'no-changes') {
          log.log('No changes to commit.');
        } else {
          log.log('Signed commit pushed to GitHub.');
        }
        return;
      }

      this.configureGitUser();

      exec(`git add ${filesPath}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit.');
        return;
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
  },

  /**
   * Commit and push files using the GitHub GraphQL `createCommitOnBranch`
   * mutation. Produces signed commits attributed to the LocalHero App. Works
   * with repos that enforce `required_signatures` rulesets.
   *
   * Returns 'no-changes' if all files match what's already on the branch,
   * 'amended' if the previous LocalHero sync commit was replaced, otherwise
   * 'new'.
   */
  async apiCommitAndPush(params: {
    branchName: string;
    filePaths: string[];
    message: string;
    isSyncMode: boolean;
  }): Promise<'no-changes' | 'new' | 'amended'> {
    const { console: log, env } = this.deps;

    const repository = env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY is not set');
    }

    const additions = await this.readFilesAsAdditions(params.filePaths);
    if (additions.length === 0) {
      return 'no-changes';
    }

    const token = await this.getTokenForPush();

    const maxRetries = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const head = await this.deps.fetchBranchHead!(repository, params.branchName, token);

        // Amend semantics: if the last commit on the branch is by the
        // LocalHero bot in sync mode, replace it instead of stacking.
        let expectedHeadOid = head.sha;
        let amended = false;
        if (params.isSyncMode && this.lastCommitIsLocalHeroBot(head) && head.parentSha) {
          expectedHeadOid = head.parentSha;
          amended = true;
        }

        const headlineAndBody = this.splitCommitMessage(params.message);

        await this.deps.createSignedCommit!({
          repositoryNameWithOwner: repository,
          branchName: params.branchName,
          expectedHeadOid,
          message: headlineAndBody,
          fileChanges: { additions },
          token
        });

        return amended ? 'amended' : 'new';
      } catch (error) {
        lastError = error;
        if (error instanceof StaleHeadError && attempt < maxRetries) {
          log.log(`Branch advanced under us, retrying (${attempt}/${maxRetries})...`);
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  },

  async readFilesAsAdditions(filePaths: string[]): Promise<{ path: string; contents: string }[]> {
    const { fs } = this.deps;
    const seen = new Set<string>();
    const additions: { path: string; contents: string }[] = [];

    for (const filePath of filePaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      if (!fs.existsSync(filePath)) continue;

      const buffer = await fs.readFile(filePath);
      additions.push({
        path: filePath,
        contents: Buffer.from(buffer).toString('base64')
      });
    }

    return additions;
  },

  lastCommitIsLocalHeroBot(head: BranchHead): boolean {
    if (!head.authorEmail) return false;
    const email = head.authorEmail.toLowerCase();
    return email.includes('localhero');
  },

  splitCommitMessage(message: string): { headline: string; body?: string } {
    const newlineIdx = message.indexOf('\n');
    if (newlineIdx === -1) return { headline: message };
    const headline = message.slice(0, newlineIdx);
    const body = message.slice(newlineIdx + 1).replace(/^\n+/, '');
    return body.length > 0 ? { headline, body } : { headline };
  }
};

/**
 * Create a GitHub actions workflow file for translations
 * @param basePath Base path of the project
 * @param translationPaths Paths to translation files
 */
export function createGitHubActionFile(basePath: string, translationPaths: string[], sourceCodePaths?: string[]): Promise<string> {
  return githubService.createGitHubActionFile(basePath, translationPaths, sourceCodePaths);
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
