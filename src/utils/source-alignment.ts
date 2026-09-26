import chalk from 'chalk';
import {
  createSourceAlignment,
  SourceAlignmentRequestError,
  type SourceAlignmentItem,
  type SourceAlignmentParams,
  type SourceAlignmentResultItem
} from '../api/source-alignments.js';
import type { AlignmentCandidate } from './alignment-candidates.js';
import type { ProjectConfig } from '../types/index.js';

export interface AlignedCell extends AlignmentCandidate {
  value: string;
}

export interface LocaleAlignmentSummary {
  aligned: number;
  unchanged: number;
  skipped: Record<string, number>;
}

export interface SourceAlignmentResult {
  enabled: boolean;
  alignedCells: AlignedCell[];
  localeSummaries: Record<string, LocaleAlignmentSummary>;
  notices: string[];
  shortUrl: string | null;
}

type AlignmentRequest = Omit<SourceAlignmentParams, 'locale' | 'items'>;

export interface Logger {
  log: (message?: any, ...optionalParams: any[]) => void;
}

interface AlignmentDependencies {
  console: Logger;
  config: ProjectConfig;
  updateTranslationFile: (
    targetPath: string,
    translations: Record<string, unknown>,
    languageCode: string,
    sourcePath: string,
    sourceLanguage?: string,
    config?: ProjectConfig
  ) => Promise<unknown>;
}

const MAX_ITEMS_PER_REQUEST = 25;
const NOT_FOUND_STATUS = 404;
const INVALID_PARAMETERS_STATUS = 422;

/**
 * Ask the backend to align the translations of reworded source texts, one
 * locale at a time, and write the aligned values into the target files. A
 * locale that fails is left untouched; the rest of the run carries on.
 */
export async function runSourceAlignment(
  candidates: AlignmentCandidate[],
  request: AlignmentRequest,
  deps: AlignmentDependencies
): Promise<SourceAlignmentResult> {
  const result: SourceAlignmentResult = {
    enabled: false,
    alignedCells: [],
    localeSummaries: {},
    notices: [],
    shortUrl: null
  };

  for (const [locale, localeCandidates] of groupBy(candidates, c => c.locale)) {
    let items: SourceAlignmentResultItem[] = [];
    try {
      for (const chunk of chunked(localeCandidates, MAX_ITEMS_PER_REQUEST)) {
        const response = await createSourceAlignment({
          ...request,
          locale,
          items: chunk.map(toRequestItem)
        });
        if (!response.enabled) return result;

        result.enabled = true;
        result.shortUrl = response.job_group?.short_url ?? result.shortUrl;
        addNotices(result, response.notices ?? []);
        items = items.concat(matchedItems(chunk, response.items));
      }
    } catch (error) {
      if (error instanceof SourceAlignmentRequestError && error.status === NOT_FOUND_STATUS) return result;
      logRequestFailure(deps.console, locale, error);
      continue;
    }

    const { summary, aligned } = classifyItems(localeCandidates, items);
    result.localeSummaries[locale] = summary;
    const written = await writeAlignedCells(aligned, locale, deps);
    summary.aligned = written.length;
    result.alignedCells.push(...written);
  }

  return result;
}

export function summarizeAlignedCells(cells: AlignedCell[]): { keysAligned: number; alignedLanguages: string[] } {
  return {
    keysAligned: new Set(cells.map(cell => `${cell.source_path}\0${cell.key}`)).size,
    alignedLanguages: [...new Set(cells.map(cell => cell.locale))]
  };
}

export function reportSourceAlignment(result: SourceAlignmentResult, logger: Logger): void {
  if (!result.enabled) return;

  const lines = Object.entries(result.localeSummaries)
    .map(([locale, summary]) => describeLocale(locale, summary))
    .filter((line): line is string => line !== null);

  if (lines.length > 0) {
    logger.log('» Translations of reworded source texts:');
    for (const line of lines) logger.log(`  ${line}`);
  }
  for (const notice of result.notices) {
    logger.log(chalk.blue(`ℹ ${notice}`));
  }
}

function describeLocale(locale: string, summary: LocaleAlignmentSummary): string | null {
  const parts: string[] = [];
  if (summary.aligned > 0) parts.push(`${summary.aligned} aligned`);
  if (summary.unchanged > 0) parts.push(`${summary.unchanged} already ${summary.unchanged === 1 ? 'fits' : 'fit'}`);

  const reasons = Object.entries(summary.skipped);
  if (reasons.length > 0) {
    const total = reasons.reduce((sum, [, count]) => sum + count, 0);
    const breakdown = reasons.map(([reason, count]) => `${count} ${reason}`).join(', ');
    parts.push(`${total} skipped (${breakdown})`);
  }

  return parts.length > 0 ? `${locale}: ${parts.join(', ')}` : null;
}

function classifyItems(
  candidates: AlignmentCandidate[],
  items: SourceAlignmentResultItem[]
): { summary: LocaleAlignmentSummary; aligned: AlignedCell[] } {
  const summary: LocaleAlignmentSummary = { aligned: 0, unchanged: 0, skipped: {} };
  const aligned: AlignedCell[] = [];
  items.forEach((item, index) => {
    if (item.status === 'aligned' && typeof item.value === 'string') {
      aligned.push({ ...candidates[index], value: item.value });
    } else if (item.status === 'unchanged') {
      summary.unchanged += 1;
    } else if (item.status === 'skipped') {
      const reason = item.reason || 'unknown';
      summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
    }
  });
  return { summary, aligned };
}

async function writeAlignedCells(
  cells: AlignedCell[],
  locale: string,
  deps: AlignmentDependencies
): Promise<AlignedCell[]> {
  const written: AlignedCell[] = [];
  for (const [targetPath, fileCells] of groupBy(cells, cell => cell.target_path)) {
    const values = Object.fromEntries(fileCells.map(cell => [cell.key, cell.value]));
    try {
      await deps.updateTranslationFile(targetPath, values, locale, fileCells[0].source_path, undefined, deps.config);
      written.push(...fileCells);
    } catch (error) {
      deps.console.log(chalk.yellow(`⚠ Could not write aligned translations to ${targetPath}: ${(error as Error).message}`));
    }
  }
  return written;
}

function matchedItems(
  requested: AlignmentCandidate[],
  returned: SourceAlignmentResultItem[]
): SourceAlignmentResultItem[] {
  const matches = returned.length === requested.length && returned.every((item, index) =>
    item.key === requested[index].key &&
    item.source_path === requested[index].source_path &&
    item.target_path === requested[index].target_path
  );
  if (!matches) {
    throw new Error('the response did not match the request');
  }
  return returned;
}

function logRequestFailure(logger: Logger, locale: string, error: unknown): void {
  const message = (error as Error).message;
  if (error instanceof SourceAlignmentRequestError && error.status === INVALID_PARAMETERS_STATUS) {
    logger.log(chalk.yellow(`⚠ Alignment request for ${locale} was rejected: ${message}`));
    return;
  }
  logger.log(chalk.yellow(`⚠ Could not align ${locale} translations to the reworded source texts: ${message}. Existing translations were kept.`));
}

function addNotices(result: SourceAlignmentResult, notices: string[]): void {
  for (const notice of notices) {
    if (!result.notices.includes(notice)) result.notices.push(notice);
  }
}

function toRequestItem(candidate: AlignmentCandidate): SourceAlignmentItem {
  return {
    source_path: candidate.source_path,
    target_path: candidate.target_path,
    format: candidate.format,
    key: candidate.key,
    previous_source: candidate.previous_source,
    source: candidate.source,
    target_base: candidate.target_base,
    target_current: candidate.target_current
  };
}

function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}
