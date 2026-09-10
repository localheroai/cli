import type { TargetChangeFile } from './target-changes.js';
import type { ImportEntry, PullRequestImportResponse } from '../api/pull-request-imports.js';

export interface ImportSummary {
  importedCount: number;
  unchangedCount: number;
  sourceTextsImported: number;
}

/**
 * Splits the backend's import result into what the run summary needs: how many
 * values were accepted, how many already matched, and how many of the accepted
 * ones were reworded source texts (whose existing translations were kept).
 */
export function summarizeImport(
  files: TargetChangeFile[],
  sourceLocale: string,
  response: PullRequestImportResponse
): ImportSummary {
  const unchanged = response.unchanged ?? [];
  const notImported = new Set(
    [...response.skipped, ...unchanged].map((entry) => entryId(entry))
  );

  const sourceTextsImported = files
    .filter((file) => file.locale === sourceLocale)
    .flatMap((file) => file.changes.map((change) => ({ path: file.path, key: change.key, locale: file.locale })))
    .filter((entry) => !notImported.has(entryId(entry)) && !notImported.has(entryId({ ...entry, locale: undefined })))
    .length;

  return {
    importedCount: response.imported_count,
    unchangedCount: unchanged.length,
    sourceTextsImported
  };
}

// Older backends omit the locale; then a path plus key has to do, which only
// misfires when a multi-language file changes the same key in two locales.
function entryId(entry: ImportEntry): string {
  return JSON.stringify([entry.path, entry.locale ?? '', entry.key]);
}
