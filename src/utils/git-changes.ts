import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import chalk from 'chalk';
import type { TranslationFile, ProjectConfig, KeyIdentifier } from '../types/index.js';
import type { MissingLocaleEntry } from './translation-utils.js';
import { parseFile, flattenTranslations, extractLocaleFromPath } from './files.js';
import { PLURAL_SUFFIX_REGEX, extractBaseKeys } from './po-utils.js';

type FileWithPath = { path: string };

const SUPPORTED_EXTENSIONS = ['.json', '.yml', '.yaml', '.po', '.pot'];

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

    // Get changed keys from source files (per-file scoped)
    const changedKeysByFile = getChangedKeys(sourceFiles, baseBranch, verbose);

    if (changedKeysByFile === null) {
      if (verbose) {
        console.log(chalk.yellow('Could not determine changed keys (limit exceeded or error)'));
      }
      return null;
    }

    let totalChangedKeys = 0;
    for (const keys of changedKeysByFile.values()) {
      totalChangedKeys += keys.size;
    }

    if (totalChangedKeys === 0) {
      if (verbose) {
        console.log(chalk.dim('No changes detected in source files'));
      }
      return {};
    }

    if (verbose) {
      console.log(chalk.blue(`Found ${totalChangedKeys} changed key${totalChangedKeys === 1 ? '' : 's'}:`));

      const flatKeys: string[] = [];
      for (const [filePath, keys] of changedKeysByFile.entries()) {
        for (const key of keys) {
          flatKeys.push(`${filePath}:${key}`);
        }
      }
      const displayKeys = flatKeys.slice(0, 10);

      displayKeys.forEach(key => {
        console.log(chalk.dim(`  - ${key}`));
      });
      if (flatKeys.length > 10) {
        console.log(chalk.dim(`  ... and ${flatKeys.length - 10} more`));
      }
    }

    return filterMissing(missingByLocale, changedKeysByFile);
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

  const perFile = getChangedKeys(sourceFiles, baseBranch, verbose);
  if (perFile === null) return null;

  // `pull --changed-only` filters target-file updates by bare key name,
  // so we flatten the per-file map. The cross-file false-positive bug
  // this avoids in `translate` doesn't apply here: `pull` is filtering
  // already-translated payloads coming back from the server, not
  // deciding which source files to send for translation.
  const flat = new Set<string>();
  for (const keys of perFile.values()) {
    for (const key of keys) {
      flat.add(key);
    }
  }
  return flat;
}

/**
 * Get base branch from config, environment, or default
 */
export function getBaseBranch(config: ProjectConfig): string {
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
export function resolveCompareRef(branch: string, verbose = false): string | null {
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

export interface FileDiff {
  oldFlat: Record<string, any>;
  newFlat: Record<string, any>;
}

/**
 * Get the old (base branch) and new (working directory) flattened key maps for a file.
 * Returns null if the current file cannot be read/parsed (caller should skip).
 */
export function diffFileKeys(
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
    const err = error as Error;
    const missingAtRef = err.message.includes('exists on disk, but not in') || err.message.includes('does not exist');
    if (!missingAtRef) {
      // A git failure or an unparsable base file is NOT an empty base — falling through
      // would report every key as added, and the backend trusts those. Callers catch
      // per-file and skip.
      throw error;
    }
    if (verbose) {
      console.log(chalk.dim(`  ${file.path}: new file (all keys changed)`));
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
/**
 * Returns a Map of source file path -> Set of keys changed in THAT file.
 *
 * Per-file scoping is critical: many repos have files that share top-level
 * key names (e.g. each email template has its own `subject`, `body`). A
 * flat global Set would cause a new key in one file to falsely match
 * missing translations of the same bare name in unrelated files.
 */
function getChangedKeys(
  sourceFiles: TranslationFile[],
  baseBranch: string,
  verbose: boolean
): Map<string, Set<string>> | null {
  const resolvedRef = resolveCompareRef(baseBranch, verbose);
  if (!resolvedRef) {
    return null;
  }

  const changedKeysByFile = new Map<string, Set<string>>();
  let totalChangedKeys = 0;
  const MAX_CHANGED_KEYS = 10000;

  for (const file of sourceFiles) {
    try {
      const diff = diffFileKeys(file, resolvedRef, verbose);
      if (!diff) continue;

      const { oldFlat, newFlat } = diff;
      const fileChangedKeys: string[] = [];
      let totalChangedInFile = 0;
      const perFileSet = new Set<string>();

      for (const [key, value] of Object.entries(newFlat)) {
        if (!(key in oldFlat) || oldFlat[key] !== value) {
          if (totalChangedKeys >= MAX_CHANGED_KEYS) {
            if (verbose) {
              console.log(chalk.yellow(`Warning: Exceeded ${MAX_CHANGED_KEYS} changed keys limit`));
            }
            return null;
          }

          perFileSet.add(key);
          totalChangedKeys++;
          totalChangedInFile++;

          if (verbose && fileChangedKeys.length < 5) {
            fileChangedKeys.push(key);
          }
        }
      }

      if (perFileSet.size > 0) {
        changedKeysByFile.set(file.path, perFileSet);
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

  return changedKeysByFile;
}

export interface PerFileDiff {
  added: KeyIdentifier[];
  removed: KeyIdentifier[];
}

const MAX_CHANGED_KEYS_TOTAL = 10000;

/**
 * Build added + removed identifier lists per source file in a single git pass.
 * Also enumerates source-language files entirely deleted in the PR via
 * `git diff --diff-filter=D --name-only` (renames excluded). Returns null on
 * failure (git unavailable, ref unresolved, combined cap exceeded).
 */
export function diffSourceFilesPerFile(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Map<string, PerFileDiff> | null {
  if (!isGitAvailable()) {
    return null;
  }

  const baseBranch = getBaseBranch(config);
  const resolvedRef = resolveCompareRef(baseBranch, verbose);
  if (!resolvedRef) {
    return null;
  }

  const result = new Map<string, PerFileDiff>();
  let totalKeys = 0;

  const cap = (newTotal: number): boolean => {
    if (newTotal > MAX_CHANGED_KEYS_TOTAL) {
      if (verbose) {
        console.log(chalk.yellow(`Warning: Exceeded ${MAX_CHANGED_KEYS_TOTAL} changed keys limit`));
      }
      return true;
    }
    return false;
  };

  for (const file of sourceFiles) {
    try {
      const diff = diffFileKeys(file, resolvedRef, false);
      if (!diff) continue;

      const { oldFlat, newFlat } = diff;
      const isPo = file.format === 'po' || file.format === 'pot';
      const added: KeyIdentifier[] = [];
      const removed: KeyIdentifier[] = [];

      for (const [key, value] of Object.entries(newFlat)) {
        if (!(key in oldFlat) || oldFlat[key] !== value) {
          totalKeys++;
          if (cap(totalKeys)) return null;
          added.push(toIdentifier(key, isPo));
        }
      }

      for (const key of Object.keys(oldFlat)) {
        if (!(key in newFlat)) {
          totalKeys++;
          if (cap(totalKeys)) return null;
          removed.push(toIdentifier(key, isPo));
        }
      }

      if (added.length > 0 || removed.length > 0) {
        result.set(file.path, { added, removed });
      }
    } catch (error) {
      if (verbose) {
        const err = error as Error;
        console.log(chalk.dim(`  Skipping ${file.path} from manifest: ${err.message}`));
      }
    }
  }

  const deletedSyntheticFiles = enumerateDeletedSourceFiles(config, resolvedRef, verbose);
  for (const file of deletedSyntheticFiles) {
    if (result.has(file.path)) continue; // already handled by main loop
    try {
      const isPo = file.format === 'po' || file.format === 'pot';
      const oldFlat = readOldFlat(file, resolvedRef, verbose);
      if (!oldFlat) continue;

      const removed: KeyIdentifier[] = [];
      for (const key of Object.keys(oldFlat)) {
        totalKeys++;
        if (cap(totalKeys)) return null;
        removed.push(toIdentifier(key, isPo));
      }

      result.set(file.path, { added: [], removed });
    } catch (error) {
      if (verbose) {
        const err = error as Error;
        console.log(chalk.dim(`  Skipping deleted ${file.path}: ${err.message}`));
      }
    }
  }

  return result;
}

function readOldFlat(file: TranslationFile, resolvedRef: string, verbose: boolean): Record<string, any> | null {
  const sanitizedPath = sanitizeGitPath(file.path);
  const isPo = file.format === 'po' || file.format === 'pot';

  try {
    const oldContent = execSync(
      `git show ${resolvedRef}:"${sanitizedPath}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const oldObj = parseFile(oldContent, file.format, file.path);
    if (!oldObj) return {};
    const oldTranslations = isPo ? oldObj : extractLocaleContent(oldObj, file.locale);
    return isPo ? extractPoKeys(oldObj) : flattenTranslations(oldTranslations);
  } catch (error) {
    if (verbose) {
      console.log(chalk.dim(`  Could not read old content for ${file.path}: ${(error as Error).message}`));
    }
    return null;
  }
}

/**
 * Enumerate source-language translation files entirely deleted in the PR.
 * Returns synthetic TranslationFile entries; multi-language YAML/JSON is
 * detected by parsing the base-ref content and checking for a top-level
 * source-locale key. Renames (R*) are excluded.
 */
export function enumerateDeletedSourceFiles(
  config: ProjectConfig,
  resolvedRef: string,
  verbose: boolean
): TranslationFile[] {
  const sourceLocale = config.sourceLocale;
  if (!sourceLocale) return [];

  const configuredPaths = config.translationFiles?.paths || [];
  if (configuredPaths.length === 0) return [];

  const knownLocales = [sourceLocale, ...(config.outputLocales || [])];
  const localeRegex = config.translationFiles?.localeRegex;
  const multiLanguageEnabled = !!config.translationFiles?.multiLanguageFiles;

  let deletedPaths: string[] = [];
  try {
    const out = execSync(`git diff --diff-filter=D --name-only ${resolvedRef}..HEAD`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    deletedPaths = out.split('\n').map((p) => p.trim()).filter(Boolean);
  } catch (error) {
    if (verbose) {
      console.log(chalk.dim(`Could not enumerate deleted files: ${(error as Error).message}`));
    }
    return [];
  }
  if (deletedPaths.length === 0) return [];

  const synthetic: TranslationFile[] = [];

  for (const deletedPath of deletedPaths) {
    if (!isWithinConfiguredPaths(deletedPath, configuredPaths)) continue;

    const ext = pathExt(deletedPath);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

    const format = ext.slice(1).toLowerCase();
    const isPo = format === 'po' || format === 'pot';

    if (isPo) {
      synthetic.push({ path: deletedPath, format, locale: sourceLocale });
      continue;
    }

    let pathLocale: string | null = null;
    try {
      pathLocale = extractLocaleFromPath(deletedPath, localeRegex, knownLocales);
    } catch {
      pathLocale = null;
    }
    if (pathLocale && pathLocale.toLowerCase() === sourceLocale.toLowerCase()) {
      synthetic.push({ path: deletedPath, format, locale: sourceLocale });
      continue;
    }
    if (pathLocale && pathLocale.toLowerCase() !== sourceLocale.toLowerCase()) {
      continue;
    }

    if (multiLanguageEnabled) {
      try {
        const oldContent = execSync(
          `git show ${resolvedRef}:"${sanitizeGitPath(deletedPath)}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const parsed = parseFile(oldContent, format, deletedPath);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as any)[sourceLocale]) {
          synthetic.push({
            path: deletedPath,
            format,
            locale: sourceLocale,
            hasLanguageWrapper: true,
            multiLanguage: true
          });
        }
      } catch (error) {
        if (verbose) {
          console.log(chalk.dim(`  Skipping deleted ${deletedPath} (parse): ${(error as Error).message}`));
        }
      }
    }
  }

  return synthetic;
}

function pathExt(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot < 0 ? '' : p.slice(dot).toLowerCase();
}

function isWithinConfiguredPaths(filePath: string, configuredPaths: string[]): boolean {
  return configuredPaths.some((cp) => {
    if (!cp) return false;
    const normalized = cp.endsWith('/') ? cp : `${cp}/`;
    return filePath === cp || filePath.startsWith(normalized);
  });
}

function toIdentifier(key: string, isPo: boolean): KeyIdentifier {
  const identifier: KeyIdentifier = { name: key };
  if (isPo) {
    const pipeIndex = key.indexOf('|');
    if (pipeIndex > 0) {
      identifier.context = key.substring(0, pipeIndex);
      identifier.name = key.substring(pipeIndex + 1);
    }
  }
  return identifier;
}

export function getChangedKeysPerFile(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Map<string, KeyIdentifier[]> | null {
  const perFile = diffSourceFilesPerFile(sourceFiles, config, verbose);
  if (perFile === null) return null;

  const out = new Map<string, KeyIdentifier[]>();
  for (const [path, { added }] of perFile.entries()) {
    if (added.length > 0) {
      out.set(path, added);
    }
  }
  return out;
}

export function getRemovedKeysPerFile(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Map<string, KeyIdentifier[]> | null {
  const perFile = diffSourceFilesPerFile(sourceFiles, config, verbose);
  if (perFile === null) return null;

  const out = new Map<string, KeyIdentifier[]>();
  for (const [path, { removed }] of perFile.entries()) {
    if (removed.length > 0) {
      out.set(path, removed);
    }
  }
  return out;
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
 * Returns null when the diff failed (caller should omit the wire field).
 * Returns {} when diff succeeded with no removals.
 */
export function getRemovedKeysManifestForFinalize(
  sourceFiles: TranslationFile[],
  config: ProjectConfig,
  verbose: boolean
): Record<string, KeyIdentifier[]> | null {
  const perFile = getRemovedKeysPerFile(sourceFiles, config, verbose);
  if (perFile === null) return null;
  return Object.fromEntries(perFile);
}

/**
 * Filter missing translations by changed keys, scoped per source file.
 *
 * The scoping is critical: a flat (file-agnostic) match would let a key
 * introduced in file A falsely pull missing translations of the same bare
 * name from unrelated file B. Many repos legitimately use the same
 * top-level key names across files (e.g. each email template has its own
 * `subject` / `body`), so cross-file matching is incorrect.
 *
 * For plural forms, if ANY variant of a base key changed IN THE SAME
 * SOURCE FILE, include ALL variants for the target language. This handles
 * cases where source and target languages have different plural form
 * counts, without leaking across files.
 */
function filterMissing(
  missingByLocale: Record<string, MissingLocaleEntry>,
  changedKeysByFile: Map<string, Set<string>>
): Record<string, MissingLocaleEntry> {
  const filtered: Record<string, MissingLocaleEntry> = {};

  // Pre-compute the base-key set (plural-stripped) per file. Cheap, and
  // keeps the inner loop free of repeated regex work.
  const baseChangedKeysByFile = new Map<string, Set<string>>();
  for (const [filePath, keys] of changedKeysByFile.entries()) {
    baseChangedKeysByFile.set(filePath, extractBaseKeys(keys));
  }

  for (const [localeKey, entry] of Object.entries(missingByLocale)) {
    const changedKeysForThisFile = changedKeysByFile.get(entry.path);
    if (!changedKeysForThisFile) continue;

    const baseChangedKeysForThisFile = baseChangedKeysByFile.get(entry.path) ?? new Set<string>();

    const filteredKeys: Record<string, any> = {};
    let count = 0;

    for (const [key, details] of Object.entries(entry.keys)) {
      if (changedKeysForThisFile.has(key)) {
        filteredKeys[key] = details;
        count++;
      } else {
        // Plural variant: include only if base key changed IN THIS FILE.
        const baseKey = key.replace(PLURAL_SUFFIX_REGEX, '');
        if (baseKey !== key && baseChangedKeysForThisFile.has(baseKey)) {
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
