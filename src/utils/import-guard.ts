import chalk from 'chalk';
import { execFileSync } from 'child_process';
import path from 'path';
import { flatValuesAt } from './git-changes.js';
import { fetchActionToken, MISSING_TOKEN_ERROR } from './github.js';
import type { TargetChange, TargetChangeFile } from './target-changes.js';
import type { Logger } from './source-alignment.js';

const TIP = 'FETCH_HEAD';
const MASKED_TOKEN = '***TOKEN***';

interface ImportGuardDependencies {
  env: NodeJS.ProcessEnv;
  git: (args: string[]) => string;
  fetchActionToken: () => Promise<{ token: string | null }>;
  flatValuesAt: typeof flatValuesAt;
}

const defaultDependencies: ImportGuardDependencies = {
  env: process.env,
  git: (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: 'pipe' }).trim(),
  fetchActionToken,
  flatValuesAt
};

type TipValues = (file: { path: string; format: string; locale: string }) => Record<string, unknown> | null;

/**
 * A run imports the values it checked out. When the pull request branch moved
 * since (a Localhero sync, a developer push), the newer commit owns every cell
 * it holds differently: importing ours would replace a value the branch no
 * longer has.
 */
export const importGuard = {
  deps: { ...defaultDependencies },
  fetchFailureReported: false,

  setDependencies(customDeps: Partial<ImportGuardDependencies> = {}): typeof importGuard {
    this.deps = { ...defaultDependencies, ...customDeps };
    this.fetchFailureReported = false;
    return this;
  },

  async leaveOutMovedCells(files: TargetChangeFile[], sourceLocale: string, logger: Logger): Promise<TargetChangeFile[]> {
    const { env, git } = this.deps;
    const branch = env.GITHUB_HEAD_REF;
    if (env.GITHUB_ACTIONS !== 'true' || !branch || files.length === 0) return files;

    let moved: boolean;
    try {
      await this.fetchBranchTip(branch);
      moved = git(['rev-parse', 'HEAD']) !== git(['rev-parse', TIP]);
    } catch (error) {
      if (!this.fetchFailureReported) {
        this.fetchFailureReported = true;
        logger.log(chalk.yellow(`⚠ Could not check whether the branch moved during this run (${(error as Error).message}). Sending all changed values.`));
      }
      return files;
    }
    if (!moved) return files;

    const tipValues = this.tipValuesReader();
    let leftOut = 0;
    const kept = files
      .map(file => {
        const changes = file.changes.filter(change => sameAtTip(file, change, sourceLocale, tipValues));
        leftOut += file.changes.length - changes.length;
        return { ...file, changes };
      })
      .filter(file => file.changes.length > 0);

    if (leftOut > 0) {
      const what = leftOut === 1 ? '1 value' : `${leftOut} values`;
      const owner = leftOut === 1 ? 'it is' : 'they are';
      logger.log(`» Left out ${what} the branch changed after this run started; ${owner} handled by the newer commit.`);
    }
    return kept;
  },

  /**
   * Authenticated per command, as the push is, so origin keeps the checkout's
   * URL. No --depth: in the workflow's full clone a shallow fetch would make the
   * tip a shallow boundary, and the ancestry check before replaying our commit
   * onto a moved branch could no longer pass.
   */
  async fetchBranchTip(branch: string): Promise<void> {
    const { env, git } = this.deps;
    const repository = env.GITHUB_REPOSITORY;
    if (!repository) throw new Error('GITHUB_REPOSITORY is not set');

    const { token: appToken } = await this.deps.fetchActionToken();
    const token = appToken || env.GITHUB_TOKEN;
    if (!token) throw new Error(MISSING_TOKEN_ERROR);

    try {
      git(['fetch', '--no-tags', `https://x-access-token:${token}@github.com/${repository}.git`, branch]);
    } catch (error) {
      throw new Error((error as Error).message.split(token).join(MASKED_TOKEN));
    }
  },

  tipValuesReader(): TipValues {
    const cache = new Map<string, Record<string, unknown> | null>();
    return (file) => {
      const id = `${file.locale}\0${file.path}`;
      if (!cache.has(id)) {
        try {
          cache.set(id, this.deps.flatValuesAt(file, TIP));
        } catch {
          // Unreadable at the tip: the newer commit owns the file's cells as much as if it held other values.
          cache.set(id, null);
        }
      }
      return cache.get(id) ?? null;
    };
  }
};

export function leaveOutMovedCells(files: TargetChangeFile[], sourceLocale: string, logger: Logger): Promise<TargetChangeFile[]> {
  return importGuard.leaveOutMovedCells(files, sourceLocale, logger);
}

function sameAtTip(file: TargetChangeFile, change: TargetChange, sourceLocale: string, tipValues: TipValues): boolean {
  if (!sameValue(tipValues(file)?.[change.key], change.value)) return false;
  if (change.source_value === undefined && change.aligned_source === undefined) return true;

  const sourceFile = { path: file.source_path, format: path.extname(file.source_path).slice(1), locale: sourceLocale };
  const tipSource = tipValues(sourceFile)?.[change.key];
  return [change.source_value, change.aligned_source].every(source => source === undefined || sameValue(tipSource, source));
}

// The server compares values in the form it stores them.
function sameValue(tipValue: unknown, value: string): boolean {
  if (tipValue === undefined || tipValue === null) return false;
  const stored = typeof tipValue === 'object' ? JSON.stringify(tipValue) : String(tipValue);
  return normalizeLineEndings(stored) === normalizeLineEndings(value);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
