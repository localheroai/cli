import chalk from 'chalk';
import {
  createSourceAlignment,
  SourceAlignmentRequestError,
  type SourceAlignmentItem,
  type SourceAlignmentParams,
  type SourceAlignmentResponse,
  type SourceAlignmentResultItem
} from '../api/source-alignments.js';
import type { AlignmentCandidate } from './alignment-candidates.js';
import type { ProjectConfig } from '../types/index.js';

export interface AlignedCell extends AlignmentCandidate {
  value: string;
  aligned_source?: string;
  trigger_path?: string;
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

const ALREADY_ALIGNED = 'already_aligned';

type AlignmentRequest = Omit<SourceAlignmentParams, 'locale' | 'items'>;

export interface Logger {
  log: (message?: any, ...optionalParams: any[]) => void;
}

export interface AlignmentDependencies {
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
 * Ask the backend to align the translations of reworded or added source texts,
 * one locale at a time, and write the aligned values into the target files. A
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
    let requested: AlignmentCandidate[] = [];
    let items: SourceAlignmentResultItem[] = [];
    let addedKeysRejected = false;
    try {
      for (const chunk of chunked(localeCandidates, MAX_ITEMS_PER_REQUEST)) {
        const sent = await requestChunk(chunk, locale, request);
        addedKeysRejected ||= sent.addedKeysRejected;
        if (!sent.response) continue;
        if (!sent.response.enabled) return result;

        result.enabled = true;
        result.shortUrl = sent.response.job_group?.short_url ?? result.shortUrl;
        addNotices(result, sent.response.notices ?? []);
        requested = requested.concat(sent.candidates);
        items = items.concat(matchedItems(sent.candidates, sent.response.items));
      }
    } catch (error) {
      if (error instanceof SourceAlignmentRequestError && error.status === NOT_FOUND_STATUS) return result;
      logRequestFailure(deps.console, locale, error);
      continue;
    }

    if (addedKeysRejected) {
      deps.console.log(chalk.yellow(`⚠ Could not align ${locale} translations of keys added in this branch. Existing translations were kept.`));
    }

    const { summary, aligned } = classifyItems(requested, items);
    result.localeSummaries[locale] = summary;
    const written = await writeAlignedCells(aligned, locale, deps);
    summary.aligned = written.length;
    result.alignedCells.push(...written);
  }

  return result;
}

export function summarizeAlignedCells(
  cells: AlignedCell[],
  sourceLocale: string
): { keysAligned: number; alignedLanguages: string[]; sourceTextsUpdated: number } {
  const targetCells = cells.filter(cell => cell.locale !== sourceLocale);
  return {
    keysAligned: new Set(targetCells.map(cell => `${cell.source_path}\0${cell.key}`)).size,
    alignedLanguages: [...new Set(targetCells.map(cell => cell.locale))],
    sourceTextsUpdated: cells.length - targetCells.length
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

  // Already aligned means there was nothing to do; every push re-checks the keys a branch added.
  const reasons = Object.entries(summary.skipped).filter(([reason]) => reason !== ALREADY_ALIGNED);
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

interface SentChunk {
  candidates: AlignmentCandidate[];
  response: SourceAlignmentResponse | null;
  addedKeysRejected: boolean;
}

/**
 * Older servers reject items without a previous source (keys added in this
 * branch). The chunk's rewordings are then sent again on their own so they
 * still align.
 */
async function requestChunk(chunk: AlignmentCandidate[], locale: string, request: AlignmentRequest): Promise<SentChunk> {
  try {
    return { candidates: chunk, response: await sendItems(chunk, locale, request), addedKeysRejected: false };
  } catch (error) {
    const rewordings = chunk.filter(candidate => candidate.previous_source !== null);
    const rejected = error instanceof SourceAlignmentRequestError && error.status === INVALID_PARAMETERS_STATUS;
    if (!rejected || rewordings.length === chunk.length) throw error;

    const response = rewordings.length > 0 ? await sendItems(rewordings, locale, request) : null;
    return { candidates: rewordings, response, addedKeysRejected: true };
  }
}

function sendItems(candidates: AlignmentCandidate[], locale: string, request: AlignmentRequest): Promise<SourceAlignmentResponse> {
  return createSourceAlignment({ ...request, locale, items: candidates.map(toRequestItem) });
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

export function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

export function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}
