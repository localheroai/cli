import chalk from 'chalk';
import { execFileSync } from 'child_process';
import path from 'path';
import { flatValuesAt, type FileLocation } from './git-changes.js';
import { fetchActionToken, MISSING_TOKEN_ERROR } from './github.js';
import type { TargetChange, TargetChangeFile } from './target-changes.js';
import type { Logger } from './source-alignment.js';

const TIP = 'FETCH_HEAD';
const CHECKOUT = 'HEAD';
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

type ValuesAt = (file: FileLocation) => Record<string, unknown> | null;

/**
 * When the pull request branch moved after this run's commit (a Localhero sync,
 * a developer push), the newer commit owns every cell it changed: importing
 * ours would replace a value the branch no longer has. A cell counts as changed
 * when the tip holds it differently from HEAD and from the value we send; the
 * latter is our own commit landing, as a signed commit does without moving HEAD.
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
      moved = git(['rev-parse', CHECKOUT]) !== git(['rev-parse', TIP]);
    } catch (error) {
      if (!this.fetchFailureReported) {
        this.fetchFailureReported = true;
        logger.log(chalk.yellow(`⚠ Could not check whether the branch moved during this run (${(error as Error).message}). Sending all changed values.`));
      }
      return files;
    }
    if (!moved) return files;

    const tip = this.valuesReader(TIP);
    const checkout = this.valuesReader(CHECKOUT);
    let leftOut = 0;
    const kept = files
      .map(file => {
        const changes = file.changes.filter(change => !changedOnTip(file, change, sourceLocale, tip, checkout));
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

  valuesReader(ref: string): ValuesAt {
    const cache = new Map<string, Record<string, unknown> | null>();
    return (file) => {
      const id = `${file.locale}\0${file.path}`;
      if (!cache.has(id)) {
        try {
          cache.set(id, this.deps.flatValuesAt(file, ref));
        } catch {
          // Unreadable at the tip: the newer commit owns the file's cells as much as if it had removed them.
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

function changedOnTip(
  file: TargetChangeFile,
  change: TargetChange,
  sourceLocale: string,
  tip: ValuesAt,
  checkout: ValuesAt
): boolean {
  const cellChanged = (cell: FileLocation, sent: string) => {
    const atTip = tip(cell)?.[change.key];
    return !sameValue(atTip, checkout(cell)?.[change.key]) && !sameValue(atTip, sent);
  };

  if (cellChanged(file, change.value)) return true;

  const sourceFile = { path: file.source_path, format: path.extname(file.source_path).slice(1), locale: sourceLocale };
  return [change.source_value, change.aligned_source].some(source => source !== undefined && cellChanged(sourceFile, source));
}

// The server compares values in the form it stores them; a missing cell matches only another missing one.
function sameValue(a: unknown, b: unknown): boolean {
  return storageForm(a) === storageForm(b);
}

function storageForm(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const stored = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return normalizeLineEndings(stored);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
