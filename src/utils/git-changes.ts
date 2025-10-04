import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import chalk from 'chalk';
import type { TranslationFile, ProjectConfig } from '../types/index.js';
import type { MissingLocaleEntry } from './translation-utils.js';
import { parseFile, flattenTranslations } from './files.js';
import { PLURAL_PREFIX } from './po-utils.js';

type FileWithPath = { path: string };

/**
 * Git integration for --changed-only flag
 * This module filters translations to only include keys that changed in the current branch
 */

export function hasFileChanged(file: FileWithPath, baseBranch: string): boolean {
  try {
    const sanitizedPath = sanitizeGitPath(file.path);
    const oldContent = execSync(`git show ${baseBranch}:"${sanitizedPath}"`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const newContent = readFileSync(file.path, 'utf-8');
    return oldContent !== newContent;
  } catch {
    return true;
  }
}

export function filterFilesByGitChanges<T extends FileWithPath>(
  files: T[],
  config: ProjectConfig,
  verbose: boolean
): T[] | null {
  if (!isGitAvailable()) {
    if (verbose) {
      console.log(chalk.dim('Git not available - pushing all files'));
    }
    return null;
  }

  const baseBranch = getBaseBranch(config);
  if (!branchExists(baseBranch)) {
    if (verbose) {
      console.log(chalk.dim(`Base branch '${baseBranch}' not found - pushing all files`));
    }
    return null;
  }

  const changedFiles = files.filter(file => hasFileChanged(file, baseBranch));

  if (verbose) {
    const skipped = files.length - changedFiles.length;
    if (changedFiles.length > 0) {
      console.log(chalk.blue(`Detected ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} (comparing against ${baseBranch})`));
      if (skipped > 0) {
        console.log(chalk.dim(`Skipped ${skipped} unchanged file${skipped === 1 ? '' : 's'}`));
      }
    }
  }

  return changedFiles;
}

export function filterByGitChanges(
  sourceFiles: TranslationFile[],
  missingByLocale: Record<string, MissingLocaleEntry>,
  config: ProjectConfig,
  verbose: boolean
): Record<string, MissingLocaleEntry> | null {
  try {
    if (!isGitAvailable()) {
      if (verbose) {
        console.log(chalk.dim('Git not available or not in a repository'));
      }
      return null;
    }

    const baseBranch = getBaseBranch(config);

    if (verbose) {
      console.log(chalk.blue(`Comparing against: ${baseBranch}`));
    }

    if (!branchExists(baseBranch)) {
      if (verbose) {
        console.log(chalk.yellow(`Base branch '${baseBranch}' not found`));
      }
      return null;
    }

    // Get changed keys from source files
    const changedKeys = getChangedKeys(sourceFiles, baseBranch, verbose);

    if (changedKeys.size === 0) {
      if (verbose) {
        console.log(chalk.dim('No changes detected in source files'));
      }
      return {};
    }

    if (verbose) {
      console.log(chalk.blue(`Found ${changedKeys.size} changed key${changedKeys.size === 1 ? '' : 's'}:`));

      const keysArray = Array.from(changedKeys);
      const displayKeys = keysArray.slice(0, 10);

      displayKeys.forEach(key => {
        console.log(chalk.dim(`  - ${key}`));
      });
      if (keysArray.length > 10) {
        console.log(chalk.dim(`  ... and ${keysArray.length - 10} more`));
      }
    }

    return filterMissing(missingByLocale, changedKeys);
  } catch (error) {
    if (verbose) {
      const err = error as Error;
      console.log(chalk.yellow(`Filter by git failed: ${err.message}`));
    }
    return null;
  }
}

/**
 * Extract keys from PO file parsed object
 * PO files have structure: { msgid: { value: '...', metadata: ... } }
 * We extract just msgid -> value for comparison
 */
function extractPoKeys(poObject: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, data] of Object.entries(poObject)) {
    // For PO files, extract the value without creating nested .value keys
    result[key] = typeof data === 'object' && data !== null && data.value !== undefined ? data.value : data;
  }
  return result;
}

/**
 * Check if git is available and we're in a repository
 */
export function isGitAvailable(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get base branch from config, environment, or default
 */
function getBaseBranch(config: ProjectConfig): string {
  return config.translationFiles?.baseBranch
    || process.env.GITHUB_BASE_REF
    || 'main';
}

/**
 * Sanitize file path for use in git commands
 * Removes characters that could break out of quotes
 */
function sanitizeGitPath(path: string): string {
  return path.replace(/["'`$\\]/g, '');
}

/**
 * Check if a branch exists (local or remote)
 */
function branchExists(branch: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branch}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all changed keys from source files using object-based diff
 * Compares parsed and flattened objects from base branch vs current working directory
 */
function getChangedKeys(
  sourceFiles: TranslationFile[],
  baseBranch: string,
  verbose: boolean
): Set<string> {
  const allChangedKeys = new Set<string>();

  for (const file of sourceFiles) {
    try {
      const sanitizedPath = sanitizeGitPath(file.path);
      const isPo = file.format === 'po';
      let oldFlat: Record<string, any> = {};

      try {
        const oldContent = execSync(
          `git show ${baseBranch}:"${sanitizedPath}"`,
          {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'ignore']
          }
        );
        const oldObj = parseFile(oldContent, file.format, file.path);
        oldFlat = isPo ? extractPoKeys(oldObj) : flattenTranslations(oldObj);

      } catch (error) {
        const err = error as Error;
        if (verbose) {
          // Check if it's a git error (file doesn't exist) or parse error
          if (err.message.includes('exists on disk, but not in') || err.message.includes('does not exist')) {
            console.log(chalk.dim(`  ${file.path}: new file (all keys changed)`));
          } else {
            console.log(chalk.yellow(`  ${file.path}: Parse error - ${err.message}`));
          }
        }
        // If parse fails or file doesn't exist, oldFlat remains {} - all keys will be treated as new
      }

      // Get current version from working directory
      const newContent = readFileSync(file.path, 'utf-8');
      const newObj = parseFile(newContent, file.format, file.path);
      const newFlat = isPo ? extractPoKeys(newObj) : flattenTranslations(newObj);

      // Compare flattened objects to find changed keys
      const fileChangedKeys: string[] = [];
      const MAX_KEYS_TO_COLLECT = 100; // Cap to prevent memory issues
      let totalChangedInFile = 0;

      for (const [key, value] of Object.entries(newFlat)) {
        const keyExistsInOld = key in oldFlat;
        if (!keyExistsInOld || oldFlat[key] !== value) {
          allChangedKeys.add(key);
          totalChangedInFile++;

          if (verbose && fileChangedKeys.length < MAX_KEYS_TO_COLLECT) {
            fileChangedKeys.push(key);
          }
        }
      }

      if (verbose && totalChangedInFile > 0) {
        console.log(chalk.dim(`  ${file.path}: ${totalChangedInFile} changed key${totalChangedInFile === 1 ? '' : 's'}`));
        const displayKeys = fileChangedKeys.slice(0, 5);

        displayKeys.forEach(key => {
          const status = (key in oldFlat) ? 'modified' : 'new';
          console.log(chalk.dim(`    - ${key} (${status})`));
        });

        if (totalChangedInFile > 5) {
          console.log(chalk.dim(`    ... and ${totalChangedInFile - 5} more`));
        }
      }

    } catch (error) {
      if (verbose) {
        const err = error as Error;
        console.log(chalk.dim(`  Skipping ${file.path}: ${err.message}`));
      }
    }
  }

  return allChangedKeys;
}

/**
 * Filter missing translations by changed keys
 *
 * For plural forms, if ANY variant changed, include ALL variants for the target language.
 * This handles cases where source and target languages have different plural form counts.
 */
function filterMissing(
  missingByLocale: Record<string, MissingLocaleEntry>,
  changedKeys: Set<string>
): Record<string, MissingLocaleEntry> {
  const filtered: Record<string, MissingLocaleEntry> = {};

  // Extract base keys from plural forms in changedKeys
  // E.g., "key__plural_1" -> "key"
  const baseChangedKeys = new Set<string>();
  for (const key of changedKeys) {
    const baseKey = key.replace(new RegExp(`${PLURAL_PREFIX.replace('_', '\\_')}\\d+$`), '');
    baseChangedKeys.add(baseKey);
  }

  for (const [localeKey, entry] of Object.entries(missingByLocale)) {
    const filteredKeys: Record<string, any> = {};
    let count = 0;

    for (const [key, details] of Object.entries(entry.keys)) {
      if (changedKeys.has(key)) {
        filteredKeys[key] = details;
        count++;
      } else {
        // For plural forms, check if base key changed
        const baseKey = key.replace(new RegExp(`${PLURAL_PREFIX.replace('_', '\\_')}\\d+$`), '');
        if (baseKey !== key && baseChangedKeys.has(baseKey)) {
          // This is a plural variant of a changed key - include it
          // even if the source language doesn't have this many plural forms
          filteredKeys[key] = details;
          count++;
        }
      }
    }

    if (count > 0) {
      filtered[localeKey] = {
        ...entry,
        keys: filteredKeys,
        keyCount: count
      };
    }
  }

  return filtered;
}
