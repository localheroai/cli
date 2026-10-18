import chalk from 'chalk';
import { execFileSync } from 'child_process';
import path from 'path';
import { flatValuesAt, type FileLocation } from './git-changes.js';
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

type ValuesAt = (file: FileLocation) => Record<string, unknown> | null;

/**
 * Where each edited translation lives, by source file and locale. A source text
 * written to follow an edit carries that edit as its aligned source.
 */
export type TriggerPaths = Map<string, string>;

export function triggerPathKey(sourcePath: string, locale: string): string {
  return `${sourcePath}\0${locale}`;
}

/**
 * Where the values sent come from: the files as the run found or wrote them,
 * or a commit of ours that landed on the branch (pushed, replayed or signed).
 */
export type SentValuesFrom = 'working-tree' | 'our-commit';

/**
 * When the pull request branch moved after the commit this run started from (a
 * Localhero sync, a developer push), the newer commit owns every cell it
 * changed: importing ours would replace a value the branch no longer has. A
 * cell counts as changed when the tip holds it differently from that commit and
 * from the value we send. A value our own commit landed must still be on the
 * tip as we sent it: a newer commit may have set it back to the start value.
 */
export const importGuard = {
  deps: { ...defaultDependencies },
  fetchFailureReported: false,
  baseline: null as string | null,

  setDependencies(customDeps: Partial<ImportGuardDependencies> = {}): typeof importGuard {
    this.deps = { ...defaultDependencies, ...customDeps };
    this.fetchFailureReported = false;
    this.baseline = null;
    return this;
  },

  /**
   * The commit the run starts from, read before anything is written, committed
   * or replayed: a replay moves HEAD onto the tip and would hide what changed.
   */
  recordBaseline(): void {
    try {
      this.baseline = this.deps.git(['rev-parse', 'HEAD']);
    } catch {
      this.baseline = null;
    }
  },

  async leaveOutMovedCells(
    files: TargetChangeFile[],
    sourceLocale: string,
    logger: Logger,
    valuesFrom: SentValuesFrom,
    triggerPaths: TriggerPaths = new Map()
  ): Promise<TargetChangeFile[]> {
    const { env, git } = this.deps;
    const branch = env.GITHUB_HEAD_REF;
    if (env.GITHUB_ACTIONS !== 'true' || !branch || files.length === 0) return files;

    const baseline = this.baseline;
    let moved: boolean;
    try {
      if (!baseline) throw new Error('the commit this run started from is unknown');
      await this.fetchBranchTip(branch);
      moved = git(['rev-parse', TIP]) !== baseline;
    } catch (error) {
      if (!this.fetchFailureReported) {
        this.fetchFailureReported = true;
        logger.log(chalk.yellow(`⚠ Could not check whether the branch moved during this run (${(error as Error).message}). Sending all changed values.`));
      }
      return files;
    }
    // Our landed commit must be on the tip, so a tip still at the start commit is no shortcut for it.
    if (valuesFrom === 'working-tree' && !moved) return files;
    if (!this.isInBranchHistory(baseline)) return files;

    const tip = this.valuesReader(TIP);
    const start = this.valuesReader(baseline);
    let leftOut = 0;
    const kept = files
      .map(file => {
        const changes = file.changes.filter(change => !changedOnTip(file, change, sourceLocale, valuesFrom, triggerPaths, tip, start));
        leftOut += file.changes.length - changes.length;
        return { ...file, changes };
      })
      .filter(file => file.changes.length > 0);

    if (leftOut > 0) {
      const what = leftOut === 1 ? '1 value' : `${leftOut} values`;
      logger.log(`» Left out ${what} the branch changed after this run started.`);
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

  /**
   * A merge-ref checkout or a force-push leaves the run's starting commit
   * outside the branch's history. Its values then differ from the tip for reasons that have nothing
   * to do with a newer commit (the base branch's own changes, a rewrite), so
   * the guard steps aside and the run imports as it always has.
   */
  isInBranchHistory(commit: string): boolean {
    try {
      this.deps.git(['merge-base', '--is-ancestor', commit, TIP]);
      return true;
    } catch {
      return false;
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

export function recordImportBaseline(): void {
  importGuard.recordBaseline();
}

export function leaveOutMovedCells(
  files: TargetChangeFile[],
  sourceLocale: string,
  logger: Logger,
  valuesFrom: SentValuesFrom,
  triggerPaths?: TriggerPaths
): Promise<TargetChangeFile[]> {
  return importGuard.leaveOutMovedCells(files, sourceLocale, logger, valuesFrom, triggerPaths);
}

function changedOnTip(
  file: TargetChangeFile,
  change: TargetChange,
  sourceLocale: string,
  valuesFrom: SentValuesFrom,
  triggerPaths: TriggerPaths,
  tip: ValuesAt,
  start: ValuesAt
): boolean {
  const cellChanged = (cell: FileLocation, sent: string) => {
    const atTip = tip(cell)?.[change.key];
    return !sameValue(atTip, start(cell)?.[change.key]) && !sameValue(atTip, sent);
  };

  // A reverted change withdraws a proposal only while the tip still holds the value it names.
  const mustHoldSentValue = valuesFrom === 'our-commit' || change.status === 'reverted';
  const targetChanged = mustHoldSentValue
    ? !sameValue(tip(file)?.[change.key], change.value)
    : cellChanged(file, change.value);
  if (targetChanged) return true;

  const sourceFile = fileAt(file.source_path, sourceLocale);
  if (change.source_value !== undefined && cellChanged(sourceFile, change.source_value)) return true;
  if (change.aligned_source === undefined) return false;

  const alignedTo = alignedSourceFile(file, change, sourceLocale, triggerPaths) ?? sourceFile;
  return cellChanged(alignedTo, change.aligned_source);
}

// The source text that followed an edited translation is aligned to that
// translation; every other cell is aligned to the source text.
function alignedSourceFile(
  file: TargetChangeFile,
  change: TargetChange,
  sourceLocale: string,
  triggerPaths: TriggerPaths
): FileLocation | null {
  if (file.locale !== sourceLocale || !change.trigger_locale) return null;

  const triggerPath = triggerPaths.get(triggerPathKey(file.source_path, change.trigger_locale));
  return triggerPath ? fileAt(triggerPath, change.trigger_locale) : null;
}

function fileAt(filePath: string, locale: string): FileLocation {
  return { path: filePath, format: path.extname(filePath).slice(1), locale };
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
