import chalk from 'chalk';
import {
  createSourceAlignment,
  SourceAlignmentRequestError,
  type SourceAlignmentParams,
  type SourceAlignmentResultItem
} from '../api/source-alignments.js';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import type { AlignmentCandidate } from './alignment-candidates.js';
import type { AlignedCell, AlignmentDependencies, Logger } from './source-alignment.js';
import type { TargetChangeFile } from './target-changes.js';
import { documentKeyName, documentTargetPath, isDocumentPath, toLfText, WIRE_FORMAT_MARKDOWN } from './documents.js';
import { flatValuesAt, getBaseBranch, resolveCompareRef } from './git-changes.js';

const CONCURRENCY = 4;
const NOT_FOUND_STATUS = 404;
const DOCUMENTS_OFF_CODE = 'document_file';
const ALREADY_ALIGNED = 'already_aligned';

const SKIP_REASONS: Record<string, string> = {
  edited_in_pr: 'its translation was edited in this pull request',
  translation_unpaired: 'its translation does not follow the source paragraph by paragraph',
  translation_out_of_sync: 'its translation was made from an older source text',
  translation_changed_on_mainline: 'its translation changed on the base branch',
  too_many_changes: 'more than half of the article was rewritten',
  too_large: 'the article is too large',
  validation_failed: 'the updated text did not pass the checks',
  not_mainline: 'the article is new in a pull request that has not merged'
};

export interface DocumentUpdateOutcome {
  locale: string;
  name: string;
  status: 'updated' | 'unchanged' | 'not_updated';
  reason?: string;
  handUpdates?: number;
}

export interface DocumentAlignmentResult {
  /** False when the server takes no article updates: an older server, or articles switched off. */
  available: boolean;
  alignedCells: AlignedCell[];
  outcomes: DocumentUpdateOutcome[];
  shortUrl: string | null;
}

export function emptyDocumentAlignment(): DocumentAlignmentResult {
  return { available: false, alignedCells: [], outcomes: [], shortUrl: null };
}

/**
 * An article that was on the base branch and whose source text changed in this
 * branch, paired with each translation of it that exists. The whole file is the
 * one value. A missing or blank translation is left to the translation jobs.
 */
export function collectDocumentAlignmentCandidates(
  targetChanges: TargetChangeFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  verbose: boolean
): AlignmentCandidate[] {
  const edited = targetChanges.filter(file =>
    isDocumentPath(file.path) && file.locale === config.sourceLocale && file.path === file.source_path
  );
  if (edited.length === 0) return [];

  const mergeBase = resolveCompareRef(getBaseBranch(config), verbose);
  if (!mergeBase) return [];

  const knownLocales = [config.sourceLocale, ...config.outputLocales];
  // Overlapping configured paths list a file more than once.
  const candidates = new Map<string, AlignmentCandidate>();

  for (const file of edited) {
    const change = file.changes.find(candidate => candidate.status === 'updated' && typeof candidate.old_value === 'string');
    if (!change) continue;

    for (const locale of config.outputLocales) {
      const targetPath = documentTargetPath(file.path, locale, knownLocales);
      const target = targetPath && (targetFilesByLocale[locale] ?? []).find(candidate => candidate.path === targetPath);
      if (!target) continue;

      const targetCurrent = toLfText(Buffer.from(target.content ?? '', 'base64').toString());
      if (targetCurrent.trim() === '') continue;

      candidates.set(`${locale}\0${target.path}`, {
        locale,
        source_path: file.path,
        target_path: target.path,
        format: WIRE_FORMAT_MARKDOWN,
        key: change.key,
        previous_source: change.old_value as string,
        source: change.value,
        target_base: textAt(target, mergeBase),
        target_current: targetCurrent
      });
    }
  }

  return [...candidates.values()];
}

function textAt(file: TranslationFile, ref: string): string | null {
  try {
    const value = flatValuesAt(file, ref)?.[documentKeyName(file.path)];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

type AlignmentRequest = Omit<SourceAlignmentParams, 'locale' | 'items'>;

/**
 * Ask the server to bring each translation of an edited article up to date, one
 * article and language per request, and write what comes back as the whole
 * file. One article failing never stops the next; a server that takes no
 * article updates does.
 */
export async function runDocumentAlignment(
  candidates: AlignmentCandidate[],
  request: AlignmentRequest,
  deps: AlignmentDependencies
): Promise<DocumentAlignmentResult> {
  const result: DocumentAlignmentResult = { ...emptyDocumentAlignment(), available: candidates.length > 0 };
  const queue = [...candidates];
  let unavailable: string | null = null;

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && result.available) {
      const candidate = queue.shift() as AlignmentCandidate;
      try {
        await alignDocument(candidate, request, deps, result);
      } catch (error) {
        if (error instanceof SourceAlignmentRequestError && (error.status === NOT_FOUND_STATUS || error.code === DOCUMENTS_OFF_CODE)) {
          result.available = false;
          unavailable = error.code === DOCUMENTS_OFF_CODE ? error.message : null;
        } else {
          result.outcomes.push({ ...outcomeFor(candidate), status: 'not_updated', reason: (error as Error).message });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  if (unavailable) {
    deps.console.log(chalk.yellow(`⚠ Articles were not updated: ${unavailable}`));
  }
  return result;
}

async function alignDocument(
  candidate: AlignmentCandidate,
  request: AlignmentRequest,
  deps: AlignmentDependencies,
  result: DocumentAlignmentResult
): Promise<void> {
  const { locale, ...item } = candidate;
  const response = await createSourceAlignment({ ...request, locale, items: [item] });
  const [answer] = response.items;
  if (response.items.length !== 1 || answer.key !== item.key || answer.target_path !== item.target_path) {
    throw new Error('the response did not match the request');
  }

  result.shortUrl = response.job_group?.short_url ?? result.shortUrl;
  const handUpdates = answer.hand_updates && answer.hand_updates > 0 ? { handUpdates: answer.hand_updates } : {};

  if (answer.status === 'aligned' && typeof answer.value === 'string') {
    await deps.updateTranslationFile(item.target_path, { [item.key]: answer.value }, locale, item.source_path, undefined, deps.config);
    result.alignedCells.push({ ...candidate, value: answer.value, aligned_from_digest: answer.anchor_digest });
    result.outcomes.push({ ...outcomeFor(candidate), status: 'updated', ...handUpdates });
  } else if (answer.status === 'skipped' && answer.reason !== ALREADY_ALIGNED) {
    result.outcomes.push({ ...outcomeFor(candidate), status: 'not_updated', reason: reasonInWords(answer) });
  } else {
    result.outcomes.push({ ...outcomeFor(candidate), status: 'unchanged', ...handUpdates });
  }
}

function outcomeFor(candidate: AlignmentCandidate): Pick<DocumentUpdateOutcome, 'locale' | 'name'> {
  return { locale: candidate.locale, name: candidate.key };
}

function reasonInWords(item: SourceAlignmentResultItem): string {
  const reason = item.reason || 'unknown';
  return SKIP_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

function handUpdateNote(count: number): string {
  const paragraphs = count === 1 ? '1 paragraph needs' : `${count} paragraphs need`;
  return `, ${paragraphs} a hand update (edited by a reviewer)`;
}

function describe(outcome: DocumentUpdateOutcome): string | null {
  const article = `${outcome.locale}: ${outcome.name}`;
  const note = outcome.handUpdates ? handUpdateNote(outcome.handUpdates) : '';

  if (outcome.status === 'updated') return `${article} updated${note}`;
  if (outcome.status === 'not_updated') return `${article} not updated: ${outcome.reason}`;
  return note ? `${article} already up to date${note}` : null;
}

export function reportDocumentAlignment(result: DocumentAlignmentResult, logger: Logger): void {
  const lines = result.outcomes.map(describe).filter((line): line is string => line !== null);
  if (lines.length === 0) return;

  logger.log('» Article updates:');
  for (const line of lines.sort()) logger.log(`  ${line}`);
}

export function summarizeUpdatedArticles(cells: AlignedCell[]): { articlesUpdated?: number; articleUpdateLanguages?: string[] } {
  if (cells.length === 0) return {};
  return {
    articlesUpdated: new Set(cells.map(cell => cell.source_path)).size,
    articleUpdateLanguages: [...new Set(cells.map(cell => cell.locale))]
  };
}
