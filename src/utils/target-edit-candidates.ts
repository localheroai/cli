import { readFileSync } from 'fs';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import { getBaseBranch, resolveCompareRef, extractLocaleContent, type FileDiff } from './git-changes.js';
import { parseFile } from './files.js';
import { findTargetFile } from './translation-utils.js';
import type { TargetChangeFile } from './target-changes.js';
import type { TargetEditItem, TargetEditTarget } from '../api/target-edit-alignments.js';
import { ALIGNABLE_FORMATS, isFilledString, isRewording, readDiff, uniqueByPath } from './alignment-candidates.js';

export interface TargetEditCandidateTarget extends TargetEditTarget {
  format: string;
  writable: boolean;
}

export interface TargetEditCandidate extends Omit<TargetEditItem, 'targets'> {
  targets: TargetEditCandidateTarget[];
}


/**
 * Collect the keys whose translation or source text this branch changed, with
 * the source text and every locale's value at the merge-base and now. The
 * backend decides which edit, if any, the source text should follow. Keys the
 * source does not have at the merge-base are left out: an edit needs a before.
 */
export function collectTargetEditCandidates(
  targetChanges: TargetChangeFile[],
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  verbose: boolean,
  ignoreMatcher?: (keyName: string) => boolean
): TargetEditCandidate[] {
  const editedKeysBySource = editedKeys(targetChanges, ignoreMatcher);
  const editedSourceFiles = uniqueByPath(sourceFiles).filter(file =>
    ALIGNABLE_FORMATS.has(file.format.toLowerCase()) && editedKeysBySource.has(file.path) && writableUnderLocale(file)
  );
  if (editedSourceFiles.length === 0) return [];

  const resolvedRef = resolveCompareRef(getBaseBranch(config), verbose);
  if (!resolvedRef) return [];

  const candidates: TargetEditCandidate[] = [];
  for (const sourceFile of editedSourceFiles) {
    const sourceDiff = readDiff(sourceFile, resolvedRef, verbose);
    if (!sourceDiff) continue;

    const targetDiffs = readTargetDiffs(sourceFile, targetFilesByLocale, config, resolvedRef, verbose);

    for (const key of editedKeysBySource.get(sourceFile.path) ?? []) {
      const sourceBase = sourceDiff.oldFlat[key];
      const source = sourceDiff.newFlat[key];
      if (!isFilledString(sourceBase) || !isFilledString(source)) continue;

      const targets = targetsWithKey(targetDiffs, key);
      if (targets.length === 0) continue;

      candidates.push({ source_path: sourceFile.path, format: sourceFile.format, key, source_base: sourceBase, source, targets });
    }
  }

  return candidates;
}

const YAML_FORMATS = new Set(['yml', 'yaml']);

// The YAML writer always puts the key under a locale root; in a file without
// one it would add a second tree that hides the existing keys. Such a target
// still counts as an edited language; it is just never written.
function writableUnderLocale(file: TranslationFile): boolean {
  if (!YAML_FORMATS.has(file.format.toLowerCase())) return true;

  try {
    const parsed = parseFile(readFileSync(file.path, 'utf-8'), file.format, file.path);
    return extractLocaleContent(parsed, file.locale) !== parsed;
  } catch {
    return false;
  }
}

interface TargetDiff {
  locale: string;
  file: TranslationFile;
  diff: FileDiff;
  writable: boolean;
}

function readTargetDiffs(
  sourceFile: TranslationFile,
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  resolvedRef: string,
  verbose: boolean
): TargetDiff[] {
  const diffs: TargetDiff[] = [];
  for (const locale of config.outputLocales) {
    const file = findTargetFile(targetFilesByLocale[locale] ?? [], locale, sourceFile, config.sourceLocale);
    if (!file) continue;

    const diff = readDiff(file, resolvedRef, verbose);
    if (diff) diffs.push({ locale, file, diff, writable: writableUnderLocale(file) });
  }
  return diffs;
}

function targetsWithKey(targetDiffs: TargetDiff[], key: string): TargetEditCandidateTarget[] {
  return targetDiffs.flatMap(({ locale, file, diff, writable }) => {
    const current = diff.newFlat[key];
    if (!isFilledString(current)) return [];

    const base = diff.oldFlat[key];
    return [{ locale, target_path: file.path, format: file.format, writable, base: isFilledString(base) ? base : null, current }];
  });
}

function editedKeys(
  targetChanges: TargetChangeFile[],
  ignoreMatcher?: (keyName: string) => boolean
): Map<string, Set<string>> {
  const keysBySource = new Map<string, Set<string>>();
  for (const file of targetChanges) {
    for (const change of file.changes) {
      if (!isRewording(change) || ignoreMatcher?.(change.key)) continue;

      if (!keysBySource.has(file.source_path)) keysBySource.set(file.source_path, new Set());
      keysBySource.get(file.source_path)!.add(change.key);
    }
  }
  return keysBySource;
}
