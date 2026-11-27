import chalk from 'chalk';
import {
  createPullRequestImport,
  PullRequestImportError,
  type PullRequestImportParams,
  type PullRequestImportResponse
} from '../api/pull-request-imports.js';
import { leaveOutMovedCells, triggerPathKey, type SentValuesFrom, type TriggerPaths } from './import-guard.js';
import type { TargetChangeFile } from './target-changes.js';
import type { AlignedCell, Logger } from './source-alignment.js';
import { isDocumentPath } from './documents.js';

type ImportRequest = Omit<PullRequestImportParams, 'files'> & { sourceLocale: string; valuesFrom: SentValuesFrom };

interface ImportDependencies {
  console: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_FILES_PER_REQUEST = 50;
const MAX_DOCUMENT_FILES_PER_REQUEST = 10;
const BASELINE_CHANGED = 'baseline_changed';
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
  const { sourceLocale, valuesFrom, ...importRequest } = request;
  const triggerPaths = triggerPathsOf(cells);
  let importedCount = 0;

  const importFiles = buildImportFiles(cells);
  const keyFiles = importFiles.filter(file => !isDocumentPath(file.path));
  const documentFiles = importFiles.filter(file => isDocumentPath(file.path));
  // Articles never share a request with key files and go fewer to a request.
  const chunks = [...chunkFiles(keyFiles), ...chunkFiles(documentFiles, MAX_DOCUMENT_FILES_PER_REQUEST)];

  for (const chunk of chunks) {
    let files = chunk;
    // Checked again before every attempt: a sync can land between requests or during a retry's wait.
    const sendUnmoved = async () => {
      files = await leaveOutMovedCells(files, sourceLocale, deps.console, valuesFrom, triggerPaths);
      return files.length === 0 ? null : createPullRequestImport({ ...importRequest, files });
    };
    try {
      const response = await withRetries(sendUnmoved, sleep);
      importedCount += response?.imported_count ?? 0;
      reportArticlesNotTaken(response?.skipped ?? [], deps.console);
    } catch (error) {
      const changeCount = files.reduce((sum, file) => sum + file.changes.length, 0);
      deps.console.log(chalk.yellow(`⚠ Could not send ${changeCount} aligned values to Localhero: ${(error as Error).message}. They are committed to the branch and will be picked up on the next push.`));
    }
  }

  if (importedCount > 0) {
    deps.console.log(`» Sent ${importedCount} aligned ${importedCount === 1 ? 'value' : 'values'} for review`);
  }
}

// The article changed on Localhero after the update was made; the next push makes it again.
function reportArticlesNotTaken(skipped: PullRequestImportResponse['skipped'], logger: Logger): void {
  for (const entry of skipped) {
    if (!isDocumentPath(entry.path) || entry.reason !== BASELINE_CHANGED) continue;
    const article = `${entry.locale ? `${entry.locale}: ` : ''}${entry.path.split('/').pop()}`;
    logger.log(chalk.yellow(`⚠ ${article} was not taken for review: the article changed on Localhero meanwhile. The next push sends it again.`));
  }
}

function triggerPathsOf(cells: AlignedCell[]): TriggerPaths {
  const paths: TriggerPaths = new Map();
  for (const cell of cells) {
    if (cell.trigger_locale && cell.trigger_path) {
      paths.set(triggerPathKey(cell.source_path, cell.trigger_locale), cell.trigger_path);
    }
  }
  return paths;
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
      // An article is never hydrated from a source value; it names the text it was updated from instead.
      ...(isDocumentPath(cell.target_path)
        ? cell.aligned_from_digest && { aligned_from_digest: cell.aligned_from_digest }
        : { source_value: cell.source }),
      aligned_source: cell.aligned_source ?? cell.source,
      ...(cell.trigger_locale && { trigger_locale: cell.trigger_locale })
    });
  }
  return [...files.values()];
}

function chunkFiles(files: TargetChangeFile[], maxFiles = MAX_FILES_PER_REQUEST): TargetChangeFile[][] {
  const chunks: TargetChangeFile[][] = [];
  let current: TargetChangeFile[] = [];
  let currentChanges = 0;

  for (const file of files) {
    for (let start = 0; start < file.changes.length; start += MAX_CHANGES_PER_REQUEST) {
      const piece = { ...file, changes: file.changes.slice(start, start + MAX_CHANGES_PER_REQUEST) };
      const full = current.length === maxFiles ||
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
