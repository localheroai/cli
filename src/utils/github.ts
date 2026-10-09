import { execSync, ExecSyncOptions } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { fetchGitHubInstallationToken } from '../api/github.js';
import { configService, PROJECT_CONFIG_FILE } from './config.js';
import { CommitSummary, ProjectConfig } from '../types/index.js';
import {
  createSignedCommit,
  fetchBranchHead,
  fetchChangedPaths,
  StaleHeadError,
  CreateCommitInput,
  CreateCommitResult
} from './github-graphql.js';

export type CommitResult = 'no-changes' | 'new' | 'skipped';
export const MISSING_TOKEN_ERROR = 'GITHUB_TOKEN is not set';
export const MISSING_BRANCH_ERROR = 'Could not determine branch name from GITHUB_HEAD_REF';
type SkippedCommit = 'skipped-overlap' | 'skipped-uncertain';
type SignedCommitResult = Exclude<CommitResult, 'skipped'> | SkippedCommit;

// Only an overlapping push is sure to start a new run: it touched locale files,
// which every generated `paths:` filter matches.
const TRANSLATE_SKIP_NOTICES: Record<SkippedCommit, string> = {
  'skipped-overlap': 'Branch changed during the run and touched these translation files; skipping commit. The new push triggers a fresh run.',
  'skipped-uncertain': 'Branch changed during the run; skipping commit to avoid overwriting newer work. Re-run the workflow to commit the translations.'
};
// A push never re-runs a sync, whatever it touched.
const SYNC_SKIP_NOTICES: Record<SkippedCommit, string> = {
  'skipped-overlap': 'Branch changed during the sync and touched these translation files; skipping commit. Sync again from Localhero to commit the translations.',
  'skipped-uncertain': 'Branch changed during the sync; skipping commit to avoid overwriting newer work. Sync again from Localhero to commit the translations.'
};

// A tip that keeps moving is a busy branch; stop chasing it and let a later run commit.
const MAX_COMMITS_ON_NEWER_TIP = 2;

// A failed push is classified by what git printed, not by the branch's shape:
// a read-only token can still fetch a branch that moved.
const PERMISSION_DENIED_OUTPUT = /Permission to \S+ denied|returned error: 403|Authentication failed|could not read Username/;
const BRANCH_MOVED_OUTPUT = /\((fetch first|non-fast-forward|stale info)\)|cannot lock ref/;
const PUSH_ATTEMPTS = 3;

export class PushPermissionError extends Error {}
class BranchMovedError extends Error {}

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
  fetchBranchHead?: (repositoryNameWithOwner: string, branchName: string, token: string) => Promise<string>;
  fetchChangedPaths?: (
    repositoryNameWithOwner: string,
    base: string,
    head: string,
    token: string
  ) => Promise<string[] | null>;
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
  fetchBranchHead,
  fetchChangedPaths
};

interface WorkflowOptions {
  // Which extract step the generated workflow needs. Distinct from the persisted
  // translationFiles.workflow, which controls Django .po source-file handling.
  extractor?: string;
  locales?: string[];
  // How the project installs Python dependencies, e.g. `uv sync --frozen`.
  pythonInstall?: string;
  // Umbrella apps must extract from the child app directory; from the umbrella root
  // gettext warns about conflicting backends and writes only one app's catalogs.
  extractWorkingDirectory?: string;
}

export const DJANGO_PYTHON_VERSION = '3.12';

// Django expects locale names on disk (pt_BR), while config stores language codes
// (pt-br). Region subtags longer than two characters are titlecase, not uppercase,
// so sr-latn becomes sr_Latn.
function toDjangoLocaleName(languageCode: string): string {
  const [language, region] = languageCode.split(/[-_]/);
  if (!region) {
    return language.toLowerCase();
  }
  const casedRegion = region.length > 2
    ? region.charAt(0).toUpperCase() + region.slice(1).toLowerCase()
    : region.toUpperCase();
  return `${language.toLowerCase()}_${casedRegion}`;
}

// `makemessages --all` only picks up locales that already have a directory, so a
// project with an empty locale/ would extract nothing. Naming the locales explicitly
// makes it create the catalogs on first run.
const PIP_INSTALL = 'pip install -r requirements.txt';

// uv and poetry run manage.py through their own environment, so the extract command
// has to carry the same prefix as the install step.
function manageRunner(pythonInstall: string): string {
  if (pythonInstall.startsWith('uv ')) return 'uv run python';
  if (pythonInstall.startsWith('poetry ')) return 'poetry run python';
  if (pythonInstall.startsWith('pipenv ')) return 'pipenv run python';
  return 'python';
}

// --keep-pot: Django builds the .pot from source on every run and then deletes it.
// A stock Django app has no source-locale .po, so the kept .pot is the only source
// catalog there is; without it the import has nothing to treat as source.
export function buildMakemessagesCommand(locales?: string[], pythonInstall: string = PIP_INSTALL): string {
  const runner = manageRunner(pythonInstall);
  if (!locales?.length) {
    return `${runner} manage.py makemessages --keep-pot --all`;
  }
  const localeFlags = locales.map(l => `-l ${toDjangoLocaleName(l)}`).join(' ');
  return `${runner} manage.py makemessages --keep-pot ${localeFlags}`;
}

// makemessages rewrites POT-Creation-Date in the .pot and every merged .po on each
// run, so a committed catalog would churn on every CI run with no string changes.
// Strip it from whatever this run modified or created, wherever it lives. NUL-
// delimited so paths with spaces or a leading dash survive the pipe; the trailing
// -- stops sed reading such a path as an option.
const STRIP_POT_DATE = 'git ls-files --modified --others --exclude-standard -z -- \'*.po\' \'*.pot\' | xargs -0 -r sed -i \'/^"POT-Creation-Date: /d\' --';

export const PHOENIX_ELIXIR_VERSION = '1.20';
export const PHOENIX_OTP_VERSION = '28';

// Gettext-based stacks only see messages that are already in the catalogs, so the
// workflow has to extract them first. Without this a PR that only touches source
// code runs green and translates nothing. Extraction is skipped on sync and dispatch
// runs, where the Action writes reviewed translations back and extraction would
// fight it, and on our own translation commits, which need none.
const EXTRACT_CONDITION = "github.event_name == 'pull_request' && github.actor != 'localhero-ai[bot]'";

// actions/setup-python provides python and pip, nothing else, so a project using
// uv, poetry or pipenv needs that tool installed before the install command runs.
const PYTHON_TOOL_SETUP: Record<string, string> = {
  uv: `      - uses: astral-sh/setup-uv@v5
        if: ${EXTRACT_CONDITION}

`,
  poetry: `      - name: Install poetry
        if: ${EXTRACT_CONDITION}
        run: pipx install poetry

`,
  pipenv: `      - name: Install pipenv
        if: ${EXTRACT_CONDITION}
        run: pipx install pipenv

`
};

function buildPythonToolSetup(pythonInstall: string): string {
  const tool = pythonInstall.split(' ')[0];
  return PYTHON_TOOL_SETUP[tool] ?? '';
}

function buildDjangoExtractStep(locales?: string[], pythonInstall: string = PIP_INSTALL): string {
  return `      - uses: actions/setup-python@v5
        if: ${EXTRACT_CONDITION}
        with:
          python-version: "${DJANGO_PYTHON_VERSION}"

${buildPythonToolSetup(pythonInstall)}      - name: Extract messages
        if: ${EXTRACT_CONDITION}
        run: |
          sudo apt-get install -y -qq gettext
          ${pythonInstall}
          ${buildMakemessagesCommand(locales, pythonInstall)}

          # Optional: makemessages rewrites the creation-date header on every run,
          # so without this line every CI run shows a one-line diff in every catalog.
          ${STRIP_POT_DATE}

`;
}

// Elixir's gettext is a pure-Elixir implementation, so no GNU gettext binaries are
// needed. `gettext.extract` forces its own compile, so deps.get is enough.
function buildPhoenixExtractStep(workingDirectory?: string): string {
  const workingDirectoryLine = workingDirectory
    ? `\n        working-directory: ${workingDirectory}`
    : '';
  return `      - uses: erlef/setup-beam@v1
        if: ${EXTRACT_CONDITION}
        with:
          elixir-version: "${PHOENIX_ELIXIR_VERSION}"
          otp-version: "${PHOENIX_OTP_VERSION}"

      - name: Extract messages
        if: ${EXTRACT_CONDITION}${workingDirectoryLine}
        run: |
          mix deps.get
          mix gettext.extract --merge

`;
}

function buildExtractStep(options: WorkflowOptions): string {
  if (options.extractor === 'django') {
    return buildDjangoExtractStep(options.locales, options.pythonInstall);
  }
  if (options.extractor === 'phoenix') {
    return buildPhoenixExtractStep(options.extractWorkingDirectory);
  }
  return '';
}

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
  async createGitHubActionFile(
    basePath: string,
    translationPaths: string[],
    sourceCodePaths?: string[],
    options: WorkflowOptions = {}
  ): Promise<string> {
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
        uses: actions/checkout@v7
        with:
          ref: \${{ github.event.client_payload.branch || github.head_ref || github.ref_name }}
          fetch-depth: 0
          persist-credentials: false

${buildExtractStep(options)}      - name: Translate
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
      throw new Error(MISSING_BRANCH_ERROR);
    }
    return branchName;
  },

  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * A moved branch is replayed onto (never for an amend, which would carry the
   * trigger commit along) or skipped; a permission failure fails at once; any
   * other failure, such as the network, is retried.
   */
  async pushWithRetry(
    branchName: string,
    token: string,
    forceWithLease: boolean = false
  ): Promise<'pushed' | SkippedCommit> {
    const { console: log } = this.deps;
    let failedAttempts = 0;
    let replays = 0;

    for (;;) {
      try {
        this.pushToGitHub(branchName, token, forceWithLease);
        return 'pushed';
      } catch (error) {
        if (error instanceof PushPermissionError) throw error;
        if (error instanceof BranchMovedError) {
          if (forceWithLease || replays === MAX_COMMITS_ON_NEWER_TIP) return 'skipped-uncertain';
          replays++;
          const outcome = await this.rebaseOntoMovedBranch(branchName);
          if (outcome !== 'rebased') return outcome;
          continue;
        }
        failedAttempts++;
        if (failedAttempts === PUSH_ATTEMPTS) throw error;
        log.log(`Push failed, retrying (${failedAttempts}/${PUSH_ATTEMPTS})...`);
        await this.sleep(2000);
      }
    }
  },

  /**
   * After a push rejected because the branch moved: replay our translation
   * commit onto the new tip when that is safe, the plain-git counterpart of
   * findTipSafeToCommitOn. Safe means the branch only moved forward from our
   * commit's parent (so nothing someone removed comes back) and the newer
   * commits left our files alone. Anything else is a skip.
   */
  async rebaseOntoMovedBranch(branchName: string): Promise<'rebased' | SkippedCommit> {
    const { console: log } = this.deps;
    const git = (args: string) => this.deps.exec(`git ${args}`, { stdio: 'pipe' }).toString().trim();
    // --no-renames lists a rename under both paths, so a renamed file of ours counts as touched.
    const changedFiles = (from: string, to: string) =>
      git(`diff --name-only --no-renames ${from} ${to}`).split('\n').filter(Boolean);

    try {
      git(`fetch --no-tags origin ${branchName}`);
      git('merge-base --is-ancestor HEAD~1 FETCH_HEAD');
    } catch {
      log.log('Could not confirm the branch only moved forward since the checkout.');
      return 'skipped-uncertain';
    }

    const theirs = new Set(changedFiles('HEAD~1', 'FETCH_HEAD'));
    const overlap = changedFiles('HEAD~1', 'HEAD').find(file => theirs.has(file));
    if (overlap) {
      log.log(`Newer commits on the branch changed ${overlap}.`);
      return 'skipped-overlap';
    }

    // --autostash: translate leaves localhero.json (lastSyncedAt) modified and unstaged.
    try {
      git('rebase --autostash --onto FETCH_HEAD HEAD~1');
    } catch {
      try { git('rebase --abort'); } catch { /* nothing to abort */ }
      log.log('Could not replay the translation commit onto the newer commits.');
      return 'skipped-uncertain';
    }
    log.log(`Branch moved during the run; replayed the translation commit onto ${git('rev-parse --short FETCH_HEAD')}.`);
    return 'rebased';
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
      ? `git push --force-with-lease origin HEAD:${branchName} 2>&1`
      : `git push origin HEAD:${branchName} 2>&1`;
    const mask = (text: string) => text.split(token).join('***TOKEN***').trim();

    try {
      const output = mask(exec(pushCmd, { stdio: 'pipe' }).toString());
      if (output) log.log(output);
    } catch (error: unknown) {
      const err = error as Error & { stdout?: Buffer | string };
      const output = mask(err.stdout?.toString() ?? '');
      if (output) log.log(output);
      const message = [mask(err.message), output].filter(Boolean).join('\n');
      if (PERMISSION_DENIED_OUTPUT.test(output)) throw new PushPermissionError(message);
      if (BRANCH_MOVED_OUTPUT.test(output)) throw new BranchMovedError(message);
      throw new Error(message);
    }
  },

  /**
   * Check if there are staged changes to commit
   */
  hasStagedChanges(): boolean {
    const { exec } = this.deps;
    const status = exec('git status --porcelain').toString();
    return status.length > 0;
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

    if (summary?.editors?.length) {
      lines.push(`Edited on Localhero.ai by ${this.listEditors(summary.editors, summary.otherEditors ?? 0)}.`);
    }

    if (summary?.viewUrl) {
      lines.push(summary.viewUrl);
    }

    return lines.join('\n\n');
  },

  listEditors(names: string[], others: number): string {
    const all = others > 0 ? [...names, `${others} ${others === 1 ? 'other' : 'others'}`] : names;
    return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0];
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
      throw new Error(MISSING_TOKEN_ERROR);
    }

    if (appToken) {
      log.log('✓ Using GitHub App token');
    } else if (errorCode === 'invalid_api_key') {
      log.warn('⚠️  Warning: API authentication failed. Using GITHUB_TOKEN instead (workflows will not trigger).');
    } else if (errorCode === 'github_app_not_installed') {
      // A push authenticated with GITHUB_TOKEN never triggers downstream
      // workflows, so required checks on this commit are left waiting with
      // nothing to report. Staying silent here leaves that PR unexplained.
      log.warn('⚠️  Warning: The Localhero GitHub App is not installed for this project. Using GITHUB_TOKEN instead, so checks on this commit will not run. Install the app to enable them.');
    } else {
      log.warn('⚠️  Warning: Failed to fetch GitHub App token. Using GITHUB_TOKEN instead (workflows will not trigger).');
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
  ): Promise<CommitResult> {
    const { exec, console: log } = this.deps;

    if (!this.isGitHubAction()) return 'no-changes';

    log.log('\nCommitting sync changes...');
    try {
      const branchName = options?.branchName || this.getBranchName();
      const commitMessage = this.buildSyncCommitMessage(syncSummary);

      if (await this.useSignedCommitsMode()) {
        const filesToCommit = [...modifiedFiles, PROJECT_CONFIG_FILE];
        const result = await this.apiCommitAndPush({
          branchName,
          filePaths: filesToCommit,
          message: commitMessage
        });
        if (result === 'no-changes') {
          log.log('No changes to commit - translations already up to date.');
          return result;
        }
        if (result === 'new') {
          log.log('✓ Signed commit created and pushed to GitHub\n');
          return result;
        }
        log.log(`::warning::${SYNC_SKIP_NOTICES[result]}`);
        return 'skipped';
      }

      this.configureGitUser();

      for (const filePath of modifiedFiles) {
        exec(`git add "${filePath}"`, { stdio: 'inherit' });
      }
      exec(`git add ${PROJECT_CONFIG_FILE}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit - translations already up to date.');
        return 'no-changes';
      }

      const canAmend = this.canAmendLastCommit(true);
      this.commit(commitMessage, canAmend);

      const token = await this.getTokenForPush();
      const outcome = await this.pushWithRetry(branchName, token, canAmend);
      if (outcome !== 'pushed') {
        log.log(`::warning::${SYNC_SKIP_NOTICES[outcome]}`);
        return 'skipped';
      }

      if (canAmend) {
        log.log('✓ Commit amended and pushed to GitHub\n');
      } else {
        log.log('✓ New commit created and pushed to GitHub\n');
      }
      return 'new';
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

    const summaryLines: string[] = [];
    if (translationSummary && translationSummary.keysTranslated > 0) {
      const { keysTranslated, languages } = translationSummary;
      summaryLines.push(`${keysTranslated} ${keysTranslated > 1 ? 'keys' : 'key'} in ${languages.join(', ')}`);
    }
    const keysAligned = translationSummary?.keysAligned ?? 0;
    if (keysAligned > 0) {
      const alignedLanguages = (translationSummary?.alignedLanguages ?? []).join(', ');
      summaryLines.push(`Aligned ${keysAligned} ${keysAligned > 1 ? 'keys' : 'key'} in ${alignedLanguages} to reworded source texts`);
    }

    if (summaryLines.length > 0) {
      commitMessage += `\n\n${summaryLines.join('\n')}`;

      if (translationSummary?.viewUrl) {
        commitMessage += `\n\n${translationSummary.viewUrl}`;
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
   *
   * Returns paths relative to the WORKING DIRECTORY, not the repository root:
   * `git ls-files` prints them that way unless --full-name is passed. The
   * commit API wants repository paths, which is readFilesAsAdditions's job.
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
  async autoCommitChanges(filesPath: string, translationSummary?: CommitSummary): Promise<CommitResult> {
    const { exec, console: log } = this.deps;

    if (!this.isGitHubAction()) return 'no-changes';

    log.log('Running in GitHub Actions. Committing changes...');
    try {
      const branchName = this.getBranchName();
      const commitMessage = this.buildTranslateCommitMessage(translationSummary);

      if (await this.useSignedCommitsMode()) {
        const filePaths = this.listChangedFiles(filesPath);
        const result = await this.apiCommitAndPush({
          branchName,
          filePaths,
          message: commitMessage
        });
        if (result === 'no-changes') {
          log.log('No changes to commit.');
          return result;
        }
        if (result === 'new') {
          log.log('Signed commit pushed to GitHub.');
          return result;
        }
        log.log(`::warning::${TRANSLATE_SKIP_NOTICES[result]}`);
        return 'skipped';
      }

      this.configureGitUser();

      exec(`git add ${filesPath}`, { stdio: 'inherit' });

      if (!this.hasStagedChanges()) {
        log.log('No changes to commit.');
        return 'no-changes';
      }

      this.commit(commitMessage);

      const token = await this.getTokenForPush();
      const outcome = await this.pushWithRetry(branchName, token);
      if (outcome !== 'pushed') {
        log.log(`::warning::${TRANSLATE_SKIP_NOTICES[outcome]}`);
        return 'skipped';
      }

      log.log('Changes committed and pushed successfully.');
      return 'new';
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
   * The new commit is stacked on the checkout's HEAD, which is what the files
   * were generated from. The mutation sends whole-file contents, so if the
   * branch moved during the run and the newer commits changed any of our files,
   * committing on the newer tip would revert them. GitHub rejects the stale
   * `expectedHeadOid`; we then commit on the newer tip only when the newer
   * commits left all of our files alone, and otherwise skip and let a later run
   * redo the work. The mutation has no amend primitive, so sync PRs keep the
   * bot's sync trigger commit as well.
   *
   * Returns 'no-changes' if there are no files to commit, 'skipped-overlap'
   * if a newer commit touched our files, 'skipped-uncertain' if that couldn't
   * be ruled out, otherwise 'new'.
   */
  async apiCommitAndPush(params: {
    branchName: string;
    filePaths: string[];
    message: string;
  }): Promise<SignedCommitResult> {
    const { exec, env } = this.deps;

    const repository = env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY is not set');
    }

    const additions = await this.readFilesAsAdditions(params.filePaths);
    if (additions.length === 0) {
      return 'no-changes';
    }

    const token = await this.getTokenForPush();
    const checkoutHead = exec('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
    await this.warnIfCheckoutIsNotPullRequestHead(checkoutHead);

    let expectedHeadOid = checkoutHead;
    for (let commitsOnNewerTip = 0; ; commitsOnNewerTip++) {
      try {
        await this.deps.createSignedCommit!({
          repositoryNameWithOwner: repository,
          branchName: params.branchName,
          expectedHeadOid,
          message: this.splitCommitMessage(params.message),
          fileChanges: { additions },
          token
        });
        return 'new';
      } catch (error) {
        if (!(error instanceof StaleHeadError)) throw error;
      }

      if (commitsOnNewerTip === MAX_COMMITS_ON_NEWER_TIP) return 'skipped-uncertain';

      const check = await this.findTipSafeToCommitOn({
        repository,
        branchName: params.branchName,
        checkoutHead,
        paths: additions.map(addition => addition.path),
        token
      });
      if ('skipped' in check) return check.skipped;
      expectedHeadOid = check.tip;
    }
  },

  /**
   * The branch's current tip if every commit since the checkout left `paths`
   * untouched, so our whole-file contents are still right on top of it.
   * Otherwise why it isn't safe: a newer commit touched one of them, or that
   * can't be ruled out.
   */
  async findTipSafeToCommitOn(params: {
    repository: string;
    branchName: string;
    checkoutHead: string;
    paths: string[];
    token: string;
  }): Promise<{ tip: string } | { skipped: SkippedCommit }> {
    const { console: log } = this.deps;
    const { repository, checkoutHead, token } = params;

    try {
      const tip = await this.deps.fetchBranchHead!(repository, params.branchName, token);
      const changedPaths = await this.deps.fetchChangedPaths!(repository, checkoutHead, tip, token);
      if (!changedPaths) {
        log.log(`Could not get a complete list of the files changed since ${checkoutHead.slice(0, 7)}.`);
        return { skipped: 'skipped-uncertain' };
      }

      const changed = new Set(changedPaths);
      const overlap = params.paths.find(filePath => changed.has(filePath));
      if (overlap) {
        log.log(`Newer commits on the branch changed ${overlap}.`);
        return { skipped: 'skipped-overlap' };
      }
      return { tip };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.log(`Could not check the newer commits on the branch: ${message}`);
      return { skipped: 'skipped-uncertain' };
    }
  },

  /**
   * The default actions/checkout on pull_request checks out a merge commit,
   * which is never the branch tip, so every signed commit would be skipped.
   */
  async warnIfCheckoutIsNotPullRequestHead(checkoutHead: string): Promise<void> {
    const { fs, env, console: log } = this.deps;
    const eventPath = env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return;

    let pullRequestHead: unknown;
    try {
      const event = JSON.parse((await fs.readFile(eventPath, 'utf8')).toString());
      pullRequestHead = event?.pull_request?.head?.sha;
    } catch {
      return;
    }

    if (typeof pullRequestHead !== 'string' || pullRequestHead === checkoutHead) return;

    log.log(
      `::warning::Signed commits need the pull request branch checked out. This run checked out ${checkoutHead.slice(0, 7)}, ` +
      `not the pull request head ${pullRequestHead.slice(0, 7)}, which is likely why the commit gets skipped. ` +
      'Set `ref: ${{ github.head_ref }}` on actions/checkout.'
    );
  },

  /**
   * Where the working directory sits inside the repository, "" at the root and
   * "apps/portal/" below it. --show-prefix rather than --show-toplevel plus a
   * relative(): it is already forward-slashed on every platform and immune to
   * the symlinked-cwd question.
   *
   * A git failure propagates. Falling back to "" would send a subdirectory's
   * files to the repository root, which is the bug this exists to prevent.
   */
  repositoryPrefix(): string {
    const { exec } = this.deps;
    // Only the trailing newline (\r\n on a Windows runner): a directory name may
    // legitimately begin with whitespace, and trim() would corrupt it.
    return exec('git rev-parse --show-prefix', { stdio: 'pipe' })
      .toString()
      .replace(/\r?\n$/, '');
  },

  /**
   * A path as GitHub's commit API wants it: relative to the repository root.
   *
   * Everything else in the CLI speaks working-directory paths, because that is
   * what localhero.json's paths are relative to. createCommitOnBranch resolves
   * additions[].path from the repository root instead, so a run from a
   * subdirectory wrote its files to the wrong place and reported success (#791).
   *
   * Absolutes are resolved before prefixing, never after: "apps/portal/" plus
   * "/tmp/x" normalises to "apps/portal/tmp/x", which is neither absolute nor
   * escaping, so a check that ran afterwards would pass it and upload one
   * file's bytes to an unrelated path.
   */
  toRepositoryPath(filePath: string, prefix: string): string {
    // The real path module, not this.deps.path: these are pure string
    // operations with nothing to stub, and injecting them would make every
    // caller's test mock responsible for knowing about posix normalisation.
    // An absolute path under the working directory is legitimate: the sync path
    // produces them (commands/ci.ts resolves each file and keeps the ones that
    // do not escape cwd). Relativise rather than reject, so the error below is
    // reserved for paths that genuinely escape.
    let local = filePath;
    if (path.isAbsolute(filePath)) {
      local = path.relative(process.cwd(), filePath);
      // relative() can hand back another absolute path, so the result is not
      // relative just because the input was.
      if (path.isAbsolute(local)) {
        throw new Error(`${filePath} is outside the repository`);
      }
    }

    const repoPath = path.posix.normalize(`${prefix}${local.split(path.sep).join('/')}`);

    if (repoPath === '..' || repoPath.startsWith('../')) {
      throw new Error(`${filePath} is outside the repository`);
    }

    // '', '.', './' and anything ending in '..' all resolve to the directory
    // itself rather than naming a file. node's normalize keeps a trailing slash,
    // so both spellings have to be checked; left alone they pass existsSync and
    // die in readFile with a bare EISDIR.
    const directory = prefix === '' ? '.' : prefix.replace(/\/$/, '');
    if (repoPath === directory || repoPath === `${directory}/` || repoPath.endsWith('/')) {
      throw new Error(`${filePath} is a directory, not a file to commit`);
    }

    return repoPath;
  },

  async readFilesAsAdditions(filePaths: string[]): Promise<{ path: string; contents: string }[]> {
    const { fs } = this.deps;
    const prefix = this.repositoryPrefix();
    // Keyed on the destination: "x" and "./x" are different strings that name
    // the same file, and would otherwise be sent as two additions for one path.
    const seen = new Set<string>();
    const additions: { path: string; contents: string }[] = [];

    for (const filePath of filePaths) {
      const repoPath = this.toRepositoryPath(filePath, prefix);
      if (seen.has(repoPath)) continue;

      // Read from where the file actually is; send where the API expects it.
      // The destination is claimed only once a file has really been read: a
      // path that does not exist must not reserve a destination and crowd out
      // the file that does, which silently drops it from the commit.
      if (!fs.existsSync(filePath)) continue;

      const buffer = await fs.readFile(filePath);
      seen.add(repoPath);
      additions.push({
        path: repoPath,
        contents: Buffer.from(buffer).toString('base64')
      });
    }

    return additions;
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
export function createGitHubActionFile(
  basePath: string,
  translationPaths: string[],
  sourceCodePaths?: string[],
  options?: WorkflowOptions
): Promise<string> {
  return githubService.createGitHubActionFile(basePath, translationPaths, sourceCodePaths, options);
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
export function autoCommitChanges(filesPath: string, translationSummary?: CommitSummary): Promise<CommitResult> {
  return githubService.autoCommitChanges(filesPath, translationSummary);
}
