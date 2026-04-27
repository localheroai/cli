import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import chalk from 'chalk';
import type { TranslationFile, ProjectConfig, KeyIdentifier } from '../types/index.js';
import type { MissingLocaleEntry } from './translation-utils.js';
import { parseFile, flattenTranslations } from './files.js';
import { PLURAL_SUFFIX_REGEX, extractBaseKeys } from './po-utils.js';

type FileWithPath = { path: string };

/**
 * Extract the content under the locale wrapper if present.
 * YAML/JSON files often have structure like { en: { key: value } }.
 * This extracts the inner object to get keys without the locale prefix.
 */
export function extractLocaleContent(
  obj: Record<string, any>,
  locale: string
): Record<string, any> {
  const wrapper = obj[locale];
  if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
    return wrapper;
  }
  return obj;
}

/**
 * Git integration for --changed-only flag
 * This module filters translations to only include keys that changed in the current branch
 */

export function hasFileChanged(file: FileWithPath, baseBranch: string): boolean {
  try {
    const resolvedRef = resolveCompareRef(baseBranch);
    if (!resolvedRef) {
      return true;
    }
    const sanitizedPath = sanitizeGitPath(file.path);
    const oldContent = execSync(`git show ${resolvedRef}:"${sanitizedPath}"`, {
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

    if (changedKeys === null) {
      if (verbose) {
        console.log(chalk.yellow('Could not determine changed keys (limit exceeded or error)'));
      }
      return null;
    }

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
 * Extract keys from PO/POT file parsed object
 * PO/POT files have structure: { msgid: { value: '...', metadata: ... } }
 * We extract just msgid -> value for comparison
 */
function extractPoKeys(poObject: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, data] of Object.entries(poObject)) {
    // For PO/POT files, extract the value without creating nested .value keys
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
 * Get changed keys for a project by comparing current branch to base branch
 * Returns Set of changed keys, or null if git is unavailable or base branch not found
 *
 * @param sourceFiles - Source translation files to compare
 * @param config - Project configuration
 * @param verbose - Whether to show verbose output
 * @returns Set of changed keys, or null if git unavailable/base branch not found
 */
export function getChangedKeysForProject(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Set<string> | null {
  if (!isGitAvailable()) {
    return null;
  }

  const baseBranch = getBaseBranch(config);

  if (!branchExists(baseBranch)) {
    return null;
  }

  return getChangedKeys(sourceFiles, baseBranch, verbose);
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
 * Tries multiple resolution strategies to handle various git scenarios
 */
function branchExists(branch: string): boolean {
  return resolveBranchRef(branch) !== null;
}

/**
 * Resolve a branch name to its full ref, trying multiple strategies
 * Returns the resolved ref or null if not found
 */
function resolveBranchRef(branch: string): string | null {
  const strategies = [
    branch,
    `origin/${branch}`,
    `refs/remotes/origin/${branch}`
  ];

  for (const ref of strategies) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { stdio: 'ignore' });
      return ref;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Resolve the ref to compare against for "what did this branch introduce?".
 *
 * Returns the merge-base of the base branch and HEAD (the commit where the
 * branch diverged) so we attribute changes to the right side of the split.
 * Comparing against the base branch tip directly would treat commits made on
 * the base after the branch point as if they were on the branch.
 *
 * This matches the semantics of `git diff <base>...HEAD` (three-dot), which
 * is defined as "diff from merge-base to HEAD" in gitrevisions(7).
 *
 * Falls back to the base ref tip when merge-base cannot be computed — for
 * example on shallow clones where the real ancestor was pruned — so behavior
 * degrades to the pre-fix state rather than aborting `--changed-only`.
 */
function resolveCompareRef(branch: string, verbose = false): string | null {
  const resolvedBase = resolveBranchRef(branch);
  if (!resolvedBase) return null;

  try {
    const mergeBase = execSync(`git merge-base ${resolvedBase} HEAD`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (mergeBase) {
      return mergeBase;
    }

    if (verbose) {
      console.log(chalk.yellow(`Could not find merge-base of ${resolvedBase} and HEAD — comparing against ${resolvedBase} tip. If your branch has been long-lived this can produce false-positive changes; consider deepening the fetch.`));
    }
    return resolvedBase;
  } catch {
    if (verbose) {
      console.log(chalk.yellow(`git merge-base failed for ${resolvedBase} — comparing against ${resolvedBase} tip. Check that the fetch depth covers the branch point.`));
    }
    return resolvedBase;
  }
}

interface FileDiff {
  oldFlat: Record<string, any>;
  newFlat: Record<string, any>;
}

/**
 * Get the old (base branch) and new (working directory) flattened key maps for a file.
 * Returns null if the current file cannot be read/parsed (caller should skip).
 */
function diffFileKeys(
  file: TranslationFile,
  resolvedRef: string,
  verbose: boolean
): FileDiff | null {
  const sanitizedPath = sanitizeGitPath(file.path);
  const isPo = file.format === 'po' || file.format === 'pot';

  let oldFlat: Record<string, any> = {};
  try {
    const oldContent = execSync(
      `git show ${resolvedRef}:"${sanitizedPath}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const oldObj = parseFile(oldContent, file.format, file.path);
    const oldTranslations = isPo ? oldObj : extractLocaleContent(oldObj, file.locale);
    oldFlat = isPo ? extractPoKeys(oldObj) : flattenTranslations(oldTranslations);
  } catch (error) {
    if (verbose) {
      const err = error as Error;
      if (err.message.includes('exists on disk, but not in') || err.message.includes('does not exist')) {
        console.log(chalk.dim(`  ${file.path}: new file (all keys changed)`));
      } else {
        console.log(chalk.yellow(`  ${file.path}: Parse error - ${err.message}`));
      }
    }
  }

  const newContent = readFileSync(file.path, 'utf-8');
  const newObj = parseFile(newContent, file.format, file.path);
  const newTranslations = isPo ? newObj : extractLocaleContent(newObj, file.locale);
  const newFlat = isPo ? extractPoKeys(newObj) : flattenTranslations(newTranslations);

  return { oldFlat, newFlat };
}

/**
 * Get all changed keys from source files using object-based diff.
 * Compares parsed and flattened objects from base branch vs current working directory.
 */
function getChangedKeys(
  sourceFiles: TranslationFile[],
  baseBranch: string,
  verbose: boolean
): Set<string> | null {
  const resolvedRef = resolveCompareRef(baseBranch, verbose);
  if (!resolvedRef) {
    return null;
  }

  const allChangedKeys = new Set<string>();
  const MAX_CHANGED_KEYS = 10000;

  for (const file of sourceFiles) {
    try {
      const diff = diffFileKeys(file, resolvedRef, verbose);
      if (!diff) continue;

      const { oldFlat, newFlat } = diff;
      const fileChangedKeys: string[] = [];
      let totalChangedInFile = 0;

      for (const [key, value] of Object.entries(newFlat)) {
        if (!(key in oldFlat) || oldFlat[key] !== value) {
          if (allChangedKeys.size >= MAX_CHANGED_KEYS) {
            if (verbose) {
              console.log(chalk.yellow(`Warning: Exceeded ${MAX_CHANGED_KEYS} changed keys limit`));
            }
            return null;
          }

          allChangedKeys.add(key);
          totalChangedInFile++;

          if (verbose && fileChangedKeys.length < 5) {
            fileChangedKeys.push(key);
          }
        }
      }

      if (verbose && totalChangedInFile > 0) {
        console.log(chalk.dim(`  ${file.path}: ${totalChangedInFile} changed key${totalChangedInFile === 1 ? '' : 's'}`));
        for (const key of fileChangedKeys.slice(0, 5)) {
          const status = (key in oldFlat) ? 'modified' : 'new';
          console.log(chalk.dim(`    - ${key} (${status})`));
        }
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
 * Get changed keys per file, returning a Map of file path to key identifiers.
 * Used to build the manifest for the finalize endpoint.
 *
 * Returns null on failure (git unavailable, ref resolution error, safety limit exceeded).
 * Returns an empty Map if no changes detected (all files checked, zero diffs).
 */
export function getChangedKeysPerFile(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Map<string, KeyIdentifier[]> | null {
  if (!isGitAvailable()) {
    return null;
  }

  const baseBranch = getBaseBranch(config);
  const resolvedRef = resolveCompareRef(baseBranch, verbose);
  if (!resolvedRef) {
    return null;
  }

  const result = new Map<string, KeyIdentifier[]>();
  const MAX_CHANGED_KEYS = 10000;
  let totalKeys = 0;

  for (const file of sourceFiles) {
    try {
      const diff = diffFileKeys(file, resolvedRef, false);
      if (!diff) continue;

      const { oldFlat, newFlat } = diff;
      const isPo = file.format === 'po' || file.format === 'pot';
      const fileKeys: KeyIdentifier[] = [];

      for (const [key, value] of Object.entries(newFlat)) {
        if (!(key in oldFlat) || oldFlat[key] !== value) {
          totalKeys++;
          if (totalKeys > MAX_CHANGED_KEYS) {
            if (verbose) {
              console.log(chalk.yellow(`Warning: Exceeded ${MAX_CHANGED_KEYS} changed keys limit`));
            }
            return null;
          }

          const identifier: KeyIdentifier = { name: key };
          if (isPo) {
            const pipeIndex = key.indexOf('|');
            if (pipeIndex > 0) {
              identifier.context = key.substring(0, pipeIndex);
              identifier.name = key.substring(pipeIndex + 1);
            }
          }
          fileKeys.push(identifier);
        }
      }

      result.set(file.path, fileKeys);
    } catch (error) {
      if (verbose) {
        const err = error as Error;
        console.log(chalk.dim(`  Skipping ${file.path} from manifest: ${err.message}`));
      }
    }
  }

  return result;
}

/**
 * Build the manifest payload for the finalize endpoint.
 * Wraps getChangedKeysPerFile and converts to a plain object suitable for JSON.
 *
 * Returns null on failure (signals CLI should skip finalize).
 * Returns {} when all files were checked but have zero changes.
 */
export function getManifestForFinalize(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Record<string, KeyIdentifier[]> | null {
  const perFile = getChangedKeysPerFile(sourceFiles, config, verbose);
  if (perFile === null) {
    return null;
  }

  return Object.fromEntries(perFile);
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
  const baseChangedKeys = extractBaseKeys(changedKeys);

  for (const [localeKey, entry] of Object.entries(missingByLocale)) {
    const filteredKeys: Record<string, any> = {};
    let count = 0;

    for (const [key, details] of Object.entries(entry.keys)) {
      if (changedKeys.has(key)) {
        filteredKeys[key] = details;
        count++;
      } else {
        // For plural forms, check if base key changed
        const baseKey = key.replace(PLURAL_SUFFIX_REGEX, '');
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
