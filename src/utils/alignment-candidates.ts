import chalk from 'chalk';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import { getBaseBranch, resolveCompareRef, diffFileKeys, type FileDiff } from './git-changes.js';
import { findTargetFile } from './translation-utils.js';
import type { TargetChangeFile } from './target-changes.js';
import type { SourceAlignmentItem } from '../api/source-alignments.js';

export interface AlignmentCandidate extends SourceAlignmentItem {
  locale: string;
}

const ALIGNABLE_FORMATS = new Set(['yml', 'yaml', 'json']);

/**
 * Pair every source text reworded in this branch with each target locale's
 * translation of it. Keys a target doesn't have are left to the missing-key flow.
 */
export function collectAlignmentCandidates(
  targetChanges: TargetChangeFile[],
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  verbose: boolean
): AlignmentCandidate[] {
  const rewordedFiles = targetChanges
    .filter(file => isSourcePass(file, config.sourceLocale))
    .map(file => ({ ...file, changes: file.changes.filter(isRewording) }))
    .filter(file => file.changes.length > 0);
  if (rewordedFiles.length === 0) return [];

  const resolvedRef = resolveCompareRef(getBaseBranch(config), verbose);
  if (!resolvedRef) return [];

  const candidates: AlignmentCandidate[] = [];
  for (const locale of config.outputLocales) {
    for (const rewordedFile of rewordedFiles) {
      const sourceFile = sourceFiles.find(file => file.path === rewordedFile.path);
      if (!sourceFile) continue;

      const targetFile = findTargetFile(targetFilesByLocale[locale] ?? [], locale, sourceFile, config.sourceLocale);
      if (!targetFile) continue;

      const diff = readTargetDiff(targetFile, resolvedRef, verbose);
      if (!diff) continue;

      for (const change of rewordedFile.changes) {
        const targetCurrent = diff.newFlat[change.key];
        // An absent or empty target is filled by the missing-key flow, which would overwrite an aligned value.
        if (!isFilledString(targetCurrent)) continue;

        const targetBase = diff.oldFlat[change.key];
        candidates.push({
          locale,
          source_path: sourceFile.path,
          target_path: targetFile.path,
          format: targetFile.format,
          key: change.key,
          previous_source: change.old_value as string,
          source: change.value,
          target_base: typeof targetBase === 'string' ? targetBase : null,
          target_current: targetCurrent
        });
      }
    }
  }

  return candidates;
}

function isSourcePass(file: TargetChangeFile, sourceLocale: string): boolean {
  return file.locale === sourceLocale &&
    file.path === file.source_path &&
    ALIGNABLE_FORMATS.has(file.format.toLowerCase());
}

function isRewording(change: TargetChangeFile['changes'][number]): boolean {
  return change.status === 'updated' && isFilledString(change.old_value) && isFilledString(change.value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function readTargetDiff(targetFile: TranslationFile, resolvedRef: string, verbose: boolean): FileDiff | null {
  try {
    return diffFileKeys(targetFile, resolvedRef, verbose);
  } catch (error) {
    if (verbose) {
      console.log(chalk.dim(`  ${targetFile.path}: skipping alignment, ${(error as Error).message}`));
    }
    return null;
  }
}
