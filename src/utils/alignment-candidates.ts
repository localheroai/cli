import chalk from 'chalk';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import { getBaseBranch, resolveCompareRef, diffFileKeys, type FileDiff } from './git-changes.js';
import { findTargetFile } from './translation-utils.js';
import type { TargetChangeFile } from './target-changes.js';
import type { SourceAlignmentItem } from '../api/source-alignments.js';

export interface AlignmentCandidate extends SourceAlignmentItem {
  locale: string;
}

export const ALIGNABLE_FORMATS = new Set(['yml', 'yaml', 'json']);
// Added keys are re-checked on every push, so past this many cells they are skipped to keep runs fast.
const MAX_ADDED_CELLS = 500;

interface SourceEdit {
  key: string;
  previousSource: string | null;
  source: string;
}

/**
 * Pair every source text reworded or added in this branch with each target
 * locale's translation of it. Added keys go without a previous source: the
 * backend works out which source text their translation was made from. Keys a
 * target doesn't have are left to the missing-key flow.
 */
export function collectAlignmentCandidates(
  targetChanges: TargetChangeFile[],
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  verbose: boolean,
  ignoreMatcher?: (keyName: string) => boolean
): AlignmentCandidate[] {
  // Overlapping paths (config/locales/ and config/locales/multi/) list a file more than once.
  const alignableSourceFiles = uniqueByPath(sourceFiles).filter(file => ALIGNABLE_FORMATS.has(file.format.toLowerCase()));
  if (alignableSourceFiles.length === 0) return [];

  const resolvedRef = resolveCompareRef(getBaseBranch(config), verbose);
  if (!resolvedRef) return [];

  const editedFiles = alignableSourceFiles
    .map(sourceFile => ({
      sourceFile,
      edits: [
        ...rewordings(targetChanges, sourceFile, config.sourceLocale),
        ...additions(sourceFile, resolvedRef, verbose, ignoreMatcher)
      ]
    }))
    .filter(file => file.edits.length > 0);

  const candidates: AlignmentCandidate[] = [];
  for (const locale of config.outputLocales) {
    for (const { sourceFile, edits } of editedFiles) {
      const targetFile = findTargetFile(targetFilesByLocale[locale] ?? [], locale, sourceFile, config.sourceLocale);
      if (!targetFile) continue;

      const diff = readDiff(targetFile, resolvedRef, verbose);
      if (!diff) continue;

      for (const edit of edits) {
        const targetCurrent = diff.newFlat[edit.key];
        // An absent or empty target is filled by the missing-key flow, which would overwrite an aligned value.
        if (!isFilledString(targetCurrent)) continue;

        const targetBase = diff.oldFlat[edit.key];
        candidates.push({
          locale,
          source_path: sourceFile.path,
          target_path: targetFile.path,
          format: targetFile.format,
          key: edit.key,
          previous_source: edit.previousSource,
          source: edit.source,
          target_base: edit.previousSource !== null && typeof targetBase === 'string' ? targetBase : null,
          target_current: targetCurrent
        });
      }
    }
  }

  return withinAddedLimit(candidates);
}

function withinAddedLimit(candidates: AlignmentCandidate[]): AlignmentCandidate[] {
  const added = candidates.filter(candidate => candidate.previous_source === null);
  if (added.length <= MAX_ADDED_CELLS) return candidates;

  const keyCount = new Set(added.map(candidate => `${candidate.source_path}\0${candidate.key}`)).size;
  console.log(chalk.yellow(`Not checking translations of ${keyCount} keys added in this branch against their English: more than ${MAX_ADDED_CELLS} translations to check.`));
  return candidates.filter(candidate => candidate.previous_source !== null);
}

export function uniqueByPath(files: TranslationFile[]): TranslationFile[] {
  return [...new Map(files.map(file => [file.path, file])).values()];
}

function rewordings(targetChanges: TargetChangeFile[], sourceFile: TranslationFile, sourceLocale: string): SourceEdit[] {
  return targetChanges
    .filter(file => isSourcePass(file, sourceLocale) && file.path === sourceFile.path)
    .flatMap(file => file.changes.filter(isRewording))
    .map(change => ({ key: change.key, previousSource: change.old_value as string, source: change.value }));
}

function additions(
  sourceFile: TranslationFile,
  resolvedRef: string,
  verbose: boolean,
  ignoreMatcher?: (keyName: string) => boolean
): SourceEdit[] {
  const diff = readDiff(sourceFile, resolvedRef, verbose);
  if (!diff) return [];

  return Object.entries(diff.newFlat)
    .filter(([key, value]) => !(key in diff.oldFlat) && isFilledString(value) && !ignoreMatcher?.(key))
    .map(([key, value]) => ({ key, previousSource: null, source: value as string }));
}

function isSourcePass(file: TargetChangeFile, sourceLocale: string): boolean {
  return file.locale === sourceLocale && file.path === file.source_path;
}

function isRewording(change: TargetChangeFile['changes'][number]): boolean {
  return change.status === 'updated' && isFilledString(change.old_value) && isFilledString(change.value);
}

export function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function readDiff(file: TranslationFile, resolvedRef: string, verbose: boolean): FileDiff | null {
  try {
    return diffFileKeys(file, resolvedRef, verbose);
  } catch (error) {
    if (verbose) {
      console.log(chalk.dim(`  ${file.path}: skipping alignment, ${(error as Error).message}`));
    }
    return null;
  }
}
