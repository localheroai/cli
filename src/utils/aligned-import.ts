import chalk from 'chalk';
import {
  createPullRequestImport,
  PullRequestImportError,
  type PullRequestImportParams
} from '../api/pull-request-imports.js';
import type { TargetChangeFile } from './target-changes.js';
import type { AlignedCell, Logger } from './source-alignment.js';

type ImportRequest = Omit<PullRequestImportParams, 'files'>;

interface ImportDependencies {
  console: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_FILES_PER_REQUEST = 50;
const MAX_CHANGES_PER_REQUEST = 1000;
const RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const SERVER_ERROR_STATUS = 500;
const FETCH_FAILED_MESSAGE = 'fetch failed';
const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);

/**
 * Stage the aligned values on the pull request, marked with the source text
 * they were aligned to. Sent only once they are in the branch. A failure is not
 * fatal: the next push brings the committed values in as ordinary edits.
 */
export async function sendAlignedImport(
  cells: AlignedCell[],
  request: ImportRequest,
  deps: ImportDependencies
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  let importedCount = 0;

  for (const files of chunkFiles(buildImportFiles(cells))) {
    const changeCount = files.reduce((sum, file) => sum + file.changes.length, 0);
    try {
      const response = await withRetries(() => createPullRequestImport({ ...request, files }), sleep);
      importedCount += response.imported_count;
    } catch (error) {
      deps.console.log(chalk.yellow(`⚠ Could not send ${changeCount} aligned values to Localhero: ${(error as Error).message}. They are committed to the branch and will be picked up on the next push.`));
    }
  }

  if (importedCount > 0) {
    deps.console.log(`» Sent ${importedCount} aligned ${importedCount === 1 ? 'value' : 'values'} for review`);
  }
}

function buildImportFiles(cells: AlignedCell[]): TargetChangeFile[] {
  const files = new Map<string, TargetChangeFile>();
  for (const cell of cells) {
    const id = `${cell.locale}\0${cell.target_path}`;
    if (!files.has(id)) {
      files.set(id, {
        path: cell.target_path,
        source_path: cell.source_path,
        locale: cell.locale,
        format: cell.format,
        changes: []
      });
    }
    files.get(id)!.changes.push({
      key: cell.key,
      status: 'updated',
      value: cell.value,
      old_value: cell.target_base,
      source_value: cell.source,
      aligned_source: cell.source
    });
  }
  return [...files.values()];
}

function chunkFiles(files: TargetChangeFile[]): TargetChangeFile[][] {
  const chunks: TargetChangeFile[][] = [];
  let current: TargetChangeFile[] = [];
  let currentChanges = 0;

  for (const file of files) {
    for (let start = 0; start < file.changes.length; start += MAX_CHANGES_PER_REQUEST) {
      const piece = { ...file, changes: file.changes.slice(start, start + MAX_CHANGES_PER_REQUEST) };
      const full = current.length === MAX_FILES_PER_REQUEST ||
        currentChanges + piece.changes.length > MAX_CHANGES_PER_REQUEST;
      if (full) {
        chunks.push(current);
        current = [];
        currentChanges = 0;
      }
      current.push(piece);
      currentChanges += piece.changes.length;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

async function withRetries<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt === RETRIES || !isRetryable(error)) throw error;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof PullRequestImportError) return error.status >= SERVER_ERROR_STATUS;
  return isNetworkError(error);
}

// Node's fetch rejects with a TypeError('fetch failed') for connection errors,
// and with a TimeoutError or AbortError when a request times out.
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return error.message === FETCH_FAILED_MESSAGE;
  return error instanceof Error && TIMEOUT_ERROR_NAMES.has(error.name);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
