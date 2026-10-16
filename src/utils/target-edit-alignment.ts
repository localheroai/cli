import { readFileSync } from 'fs';
import chalk from 'chalk';
import {
  createTargetEditAlignment,
  TargetEditAlignmentRequestError,
  type TargetEditAlignmentParams,
  type TargetEditItem,
  type TargetEditResultItem
} from '../api/target-edit-alignments.js';
import { localeCodesMatch } from './translation-processor.js';
import type { AlignmentCandidate } from './alignment-candidates.js';
import {
  chunked,
  groupBy,
  type AlignedCell,
  type AlignmentDependencies,
  type Logger,
  type SourceAlignmentResult
} from './source-alignment.js';
import type { TargetChangeFile } from './target-changes.js';
import type { TargetEditCandidate, TargetEditCandidateTarget } from './target-edit-candidates.js';
import type { TranslationFile } from '../types/index.js';

export interface TargetEditAlignmentResult {
  sourceCells: AlignedCell[];
  alignmentCandidates: AlignmentCandidate[];
  revertedChanges: TargetChangeFile[];
  writtenPaths: string[];
  localFixes: number;
  skipped: Record<string, number>;
}

type TargetEditRequest = Omit<TargetEditAlignmentParams, 'items'>;

type UpdatedItem = TargetEditResultItem & {
  source: string;
  trigger_locale: string;
  trigger_value: string;
  align_locales: string[];
};

interface UpdatedKey {
  candidate: TargetEditCandidate;
  item: UpdatedItem;
}

const MAX_ITEMS_PER_REQUEST = 25;
const MAX_KEYS = 250;
const NOT_FOUND_STATUS = 404;
const INVALID_PARAMETERS_STATUS = 422;
const UPDATED = 'updated';
const LOCAL_FIX = 'local_fix';
// Nothing to report: no translation was edited, or the developer edited the source text too.
const QUIET_STATUSES = new Set(['no_trigger', 'source_edited']);

/**
 * Ask the backend whether a translation edited in this branch changed what the
 * text says, and write the source text it sends back. The other locales then
 * follow that source text through the ordinary source alignment. An older
 * server or a project without the setting answers nothing, and the run goes on
 * as before.
 */
export async function runTargetEditAlignment(
  candidates: TargetEditCandidate[],
  request: TargetEditRequest,
  deps: AlignmentDependencies
): Promise<TargetEditAlignmentResult> {
  const result = emptyTargetEditResult();
  const updatedKeys: UpdatedKey[] = [];
  let enabled = false;
  for (const chunk of chunked(candidates.slice(0, MAX_KEYS), MAX_ITEMS_PER_REQUEST)) {
    try {
      const response = await createTargetEditAlignment({ ...request, items: chunk.map(toRequestItem) });
      if (!response.enabled) return result;

      enabled = true;
      matchedItems(chunk, response.items).forEach((item, index) => {
        if (isUpdate(item)) {
          updatedKeys.push({ candidate: chunk[index], item });
        } else if (item.status === LOCAL_FIX) {
          result.localFixes += 1;
        } else if (!QUIET_STATUSES.has(item.status)) {
          result.skipped[item.status] = (result.skipped[item.status] ?? 0) + 1;
        }
      });
    } catch (error) {
      if (error instanceof TargetEditAlignmentRequestError && error.status === NOT_FOUND_STATUS) return result;
      logRequestFailure(deps.console, error);
    }
  }

  const leftOut = candidates.length - MAX_KEYS;
  if (enabled && leftOut > 0) {
    deps.console.log(chalk.yellow(`Not following ${leftOut} more ${leftOut === 1 ? 'key' : 'keys'}: more than ${MAX_KEYS} to check.`));
  }

  for (const [sourcePath, fileKeys] of groupBy(updatedKeys, updated => updated.candidate.source_path)) {
    if (!(await writeSourceTexts(sourcePath, fileKeys, deps))) continue;

    result.writtenPaths.push(sourcePath);
    for (const updated of fileKeys) {
      result.sourceCells.push(sourceCell(updated, deps.config.sourceLocale));
      result.alignmentCandidates.push(...alignmentCandidates(updated));
      const reverted = revertedChange(updated);
      if (reverted) result.revertedChanges.push(reverted);
    }
  }

  return result;
}

export function emptyTargetEditResult(): TargetEditAlignmentResult {
  return { sourceCells: [], alignmentCandidates: [], revertedChanges: [], writtenPaths: [], localFixes: 0, skipped: {} };
}

/**
 * A key whose source text followed an edit is aligned from the source text as
 * it was before the write, for the locales the server named, instead of from
 * the first pass's rewording.
 */
export function replaceAlignmentCandidates(
  candidates: AlignmentCandidate[],
  targetEdits: Pick<TargetEditAlignmentResult, 'sourceCells' | 'alignmentCandidates'>
): AlignmentCandidate[] {
  const updated = new Set(targetEdits.sourceCells.map(keyId));
  return [
    ...candidates.filter(candidate => !updated.has(keyId(candidate))),
    ...targetEdits.alignmentCandidates
  ];
}

export function withRevertedChanges(targetChanges: TargetChangeFile[], reverted: TargetChangeFile[]): TargetChangeFile[] {
  const files = targetChanges.map(file => ({ ...file, changes: [...file.changes] }));
  for (const revertedFile of reverted) {
    const file = files.find(f => f.path === revertedFile.path && f.locale === revertedFile.locale);
    if (file) {
      file.changes.push(...revertedFile.changes);
    } else {
      files.push(revertedFile);
    }
  }
  return files;
}

export function addSourceCells(alignment: SourceAlignmentResult | null, sourceCells: AlignedCell[]): SourceAlignmentResult | null {
  if (sourceCells.length === 0) return alignment;

  const base = alignment ?? { enabled: true, alignedCells: [], localeSummaries: {}, notices: [], shortUrl: null };
  return { ...base, alignedCells: [...base.alignedCells, ...sourceCells] };
}

/**
 * Missing-key detection reads the content cached when the files were found, so
 * a file this run wrote has to be read again first.
 */
export function refreshFileContent(files: TranslationFile[], writtenPaths: string[]): void {
  const contentByPath = new Map<string, string>();
  for (const file of files) {
    if (file.content === undefined || !writtenPaths.includes(file.path)) continue;

    if (!contentByPath.has(file.path)) {
      contentByPath.set(file.path, Buffer.from(readFileSync(file.path, 'utf-8')).toString('base64'));
    }
    file.content = contentByPath.get(file.path);
  }
}

export function reportTargetEditAlignment(
  result: Pick<TargetEditAlignmentResult, 'sourceCells' | 'localFixes' | 'skipped'>,
  logger: Logger
): void {
  const lines = result.sourceCells.map(cell => `${cell.key}: ${cell.locale} updated to match the ${cell.trigger_locale} edit`);
  if (result.localFixes > 0) {
    lines.push(`${result.localFixes} left as they are: the edit kept the meaning`);
  }
  const reasons = Object.entries(result.skipped);
  if (reasons.length > 0) {
    const total = reasons.reduce((sum, [, count]) => sum + count, 0);
    lines.push(`${total} skipped (${reasons.map(([reason, count]) => `${count} ${reason}`).join(', ')})`);
  }
  if (lines.length === 0) return;

  logger.log('» Edited translations:');
  for (const line of lines) logger.log(`  ${line}`);
}

function isUpdate(item: TargetEditResultItem): item is UpdatedItem {
  return item.status === UPDATED &&
    typeof item.source === 'string' &&
    typeof item.trigger_locale === 'string' &&
    typeof item.trigger_value === 'string' &&
    Array.isArray(item.align_locales);
}

async function writeSourceTexts(sourcePath: string, keys: UpdatedKey[], deps: AlignmentDependencies): Promise<boolean> {
  const values = Object.fromEntries(keys.map(({ candidate, item }) => [candidate.key, item.source]));
  try {
    await deps.updateTranslationFile(sourcePath, values, deps.config.sourceLocale, sourcePath, undefined, deps.config);
    return true;
  } catch (error) {
    deps.console.log(chalk.yellow(`⚠ Could not write the updated source texts to ${sourcePath}: ${(error as Error).message}`));
    return false;
  }
}

function sourceCell({ candidate, item }: UpdatedKey, sourceLocale: string): AlignedCell {
  return {
    locale: sourceLocale,
    source_path: candidate.source_path,
    target_path: candidate.source_path,
    format: candidate.format,
    key: candidate.key,
    previous_source: candidate.source,
    source: item.source,
    target_base: candidate.source_base,
    target_current: candidate.source,
    value: item.source,
    trigger_locale: item.trigger_locale,
    trigger_path: findTarget(candidate, item.trigger_locale)?.target_path,
    aligned_source: item.trigger_value
  };
}

// The branch value is sent as both base and current: the source alignment reads
// the cell as untouched and aligns it from where the branch has it.
function alignmentCandidates({ candidate, item }: UpdatedKey): AlignmentCandidate[] {
  return item.align_locales
    .map(locale => findTarget(candidate, locale))
    .filter((target): target is TargetEditCandidateTarget => target !== undefined && target.writable)
    .map(target => ({
      locale: target.locale,
      source_path: candidate.source_path,
      target_path: target.target_path,
      format: target.format,
      key: candidate.key,
      previous_source: candidate.source,
      source: item.source,
      target_base: target.current,
      target_current: target.current,
      trigger_locale: item.trigger_locale
    }));
}

// The edit was undone: the trigger's own proposal is withdrawn rather than
// staging its merge-base value, which merge could apply over a newer live text.
function revertedChange({ candidate, item }: UpdatedKey): TargetChangeFile | null {
  if (!item.trigger_at_base) return null;

  const trigger = findTarget(candidate, item.trigger_locale);
  if (!trigger) return null;

  return {
    path: trigger.target_path,
    source_path: candidate.source_path,
    locale: trigger.locale,
    format: trigger.format,
    changes: [{ key: candidate.key, status: 'reverted', value: trigger.current, old_value: trigger.base }]
  };
}

function findTarget(candidate: TargetEditCandidate, locale: string): TargetEditCandidateTarget | undefined {
  return candidate.targets.find(target => localeCodesMatch(target.locale, locale));
}

function matchedItems(requested: TargetEditCandidate[], returned: TargetEditResultItem[]): TargetEditResultItem[] {
  const matches = returned.length === requested.length && returned.every((item, index) =>
    item.key === requested[index].key && item.source_path === requested[index].source_path
  );
  if (!matches) {
    throw new Error('the response did not match the request');
  }
  return returned;
}

function logRequestFailure(logger: Logger, error: unknown): void {
  const message = (error as Error).message;
  if (error instanceof TargetEditAlignmentRequestError && error.status === INVALID_PARAMETERS_STATUS) {
    logger.log(chalk.yellow(`⚠ Request to update source texts to match edited translations was rejected: ${message}`));
    return;
  }
  logger.log(chalk.yellow(`⚠ Could not update source texts to match edited translations: ${message}. Source texts were left as they are.`));
}

function toRequestItem(candidate: TargetEditCandidate): TargetEditItem {
  return {
    source_path: candidate.source_path,
    format: candidate.format,
    key: candidate.key,
    source_base: candidate.source_base,
    source: candidate.source,
    targets: candidate.targets.map(target => ({
      locale: target.locale,
      target_path: target.target_path,
      base: target.base,
      current: target.current
    }))
  };
}

function keyId(cell: { source_path: string; key: string }): string {
  return `${cell.source_path}\0${cell.key}`;
}
