import chalk from 'chalk';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import {
  isGitAvailable,
  getBaseBranch,
  resolveCompareRef,
  diffFileKeys
} from './git-changes.js';
import { findTargetFile } from './translation-utils.js';

export interface TargetChange {
  key: string;
  status: 'added' | 'updated';
  value: string;
  old_value?: string;
}

export interface TargetChangeFile {
  path: string;
  source_path: string;
  locale: string;
  format: string;
  changes: TargetChange[];
}

const MAX_TOTAL_CHANGES = 1000;

/**
 * Detect target translations the PR adds or changes, by diffing each target
 * file against the merge-base of the configured base branch. Powers the
 * bring-your-own-translations flow (backend pull_request_imports endpoint).
 *
 * Returns null when git or the base branch is unavailable, or the change cap
 * is exceeded (callers should skip ingestion). Returns [] when nothing changed.
 */
export function detectTargetChanges(
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig,
  verbose: boolean
): TargetChangeFile[] | null {
  if (!isGitAvailable()) {
    return null;
  }

  const resolvedRef = resolveCompareRef(getBaseBranch(config), verbose);
  if (!resolvedRef) {
    return null;
  }

  const result: TargetChangeFile[] = [];
  let totalChanges = 0;

  for (const [locale, targetFiles] of Object.entries(targetFilesByLocale)) {
    for (const targetFile of targetFiles) {
      const changes = detectFileChanges(targetFile, resolvedRef, verbose);
      if (changes.length === 0) continue;

      totalChanges += changes.length;
      if (totalChanges > MAX_TOTAL_CHANGES) {
        if (verbose) {
          console.log(chalk.yellow(`Skipping translation ingestion: more than ${MAX_TOTAL_CHANGES} changed target values`));
        }
        return null;
      }

      const sourcePath = sourcePathFor(targetFile, locale, sourceFiles, targetFiles, config);
      if (!sourcePath) {
        if (verbose) {
          console.log(chalk.dim(`  ${targetFile.path}: no matching source file, skipping ingestion`));
        }
        continue;
      }

      result.push({
        path: targetFile.path,
        source_path: sourcePath,
        locale,
        format: targetFile.format,
        changes
      });
    }
  }

  return result;
}

function detectFileChanges(
  targetFile: TranslationFile,
  resolvedRef: string,
  verbose: boolean
): TargetChange[] {
  try {
    const diff = diffFileKeys(targetFile, resolvedRef, verbose);
    if (!diff) return [];

    const { oldFlat, newFlat } = diff;
    const changes: TargetChange[] = [];

    for (const [key, value] of Object.entries(newFlat)) {
      if (typeof value !== 'string' || value === '') continue;

      const oldValue = oldFlat[key];
      if (typeof oldValue === 'string') {
        // Replacing one human value with another is an update with history.
        if (oldValue !== value) {
          changes.push({ key, status: 'updated', value, old_value: oldValue });
        }
      } else {
        // New key, or a null/empty placeholder being filled in: an addition.
        changes.push({ key, status: 'added', value });
      }
    }

    return changes;
  } catch (error) {
    if (verbose) {
      console.log(chalk.dim(`  Skipping ${targetFile.path}: ${(error as Error).message}`));
    }
    return [];
  }
}

/**
 * Pair a target file back to its source file using the same matching the
 * missing-translations flow uses in the source→target direction.
 */
function sourcePathFor(
  targetFile: TranslationFile,
  locale: string,
  sourceFiles: TranslationFile[],
  targetFiles: TranslationFile[],
  config: ProjectConfig
): string | null {
  if (targetFile.multiLanguage) {
    return targetFile.path;
  }

  const sourceLocale = config.sourceLocale;
  const match = sourceFiles.find((sourceFile) => {
    const paired = findTargetFile(targetFiles, locale, sourceFile, sourceLocale);
    return paired?.path === targetFile.path;
  });

  return match?.path ?? null;
}
