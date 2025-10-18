import path from 'path';
import { flattenTranslations, parseFile } from './files.js';
import {
  TranslationFile,
  ProjectConfig,
} from '../types/index.js';
import { TranslationBatch } from './translation-processor.js';
import { findMissingPoTranslations, createUniqueKey, PLURAL_PREFIX } from './po-utils.js';

export function isDjangoWorkflow(config: ProjectConfig): boolean {
  return config.translationFiles?.workflow === 'django';
}

export function getDjangoSourcePath(targetPath: string): string {
  return targetPath.replace(
    /\/LC_MESSAGES\/([^/]+)\.po$/,
    '/LC_MESSAGES/sources/$1-generated.po'
  );
}

export interface MissingLocaleEntry {
  path: string;
  locale: string;
  targetPath: string;
  keys: Record<string, SourceKeyDetails>;
  keyCount?: number;
}

export interface BatchResult {
  batches: TranslationBatch[];
  errors: BatchError[];
}

interface BatchError {
  type: string;
  message: string;
  path: string;
}

interface TranslationKeysResult {
  missingKeys: Record<string, SourceKeyDetails>;
  skippedKeys: Record<string, SkippedKeyDetails>;
}

export type TranslationPrimitiveValue = string | boolean | string[];

export interface TranslationWithMetadata {
  value: TranslationPrimitiveValue;
  context?: string;
  metadata?: {
    po_plural?: boolean;
    plural_index?: number;
    msgid_plural?: string;
    msgid?: string;
    translator_comments?: string;
    [key: string]: unknown;
  };
  sourceKey?: string;
}

export type TranslationValue = TranslationPrimitiveValue | TranslationWithMetadata;

interface SourceKeyDetails {
  value: TranslationPrimitiveValue;
  sourceKey?: string;
  context?: string;
  metadata?: {
    po_plural?: boolean;
    plural_index?: number;
    msgid_plural?: string;
    msgid?: string;
    translator_comments?: string;
    [key: string]: unknown;
  };
}

interface SkippedKeyDetails {
  reason: string;
  value?: TranslationPrimitiveValue;
}

/**
 * Extract primitive value from any value type
 */
function extractPrimitiveValue(value: unknown): TranslationPrimitiveValue {
  if (Array.isArray(value) || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    console.warn('Unexpected object format in translation value, stringifying:', value);
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Find keys in source that are missing from target
 * @param sourceKeys The source translation keys
 * @param targetKeys The target translation keys
 * @returns Object containing missing and skipped keys
 */
export function findMissingTranslations(
  sourceKeys: Record<string, any>,
  targetKeys: Record<string, any>
): TranslationKeysResult {
  const missingKeys: Record<string, SourceKeyDetails> = {};
  const skippedKeys: Record<string, SkippedKeyDetails> = {};

  for (const [key, details] of Object.entries(sourceKeys)) {
    if (typeof details === 'string') {
      if (
        details.toLowerCase().includes('wip_') ||
        details.toLowerCase().includes('_wip') ||
        details.toLowerCase().includes('__skip_translation__')
      ) {
        skippedKeys[key] = {
          value: details,
          reason: 'wip'
        };
        continue;
      }

      if (!targetKeys[key]) {
        missingKeys[key] = {
          value: details,
          sourceKey: key
        };
      }
      continue;
    }

    if (typeof details === 'boolean') {
      const targetValue = targetKeys[key];
      if (targetValue === undefined || (typeof targetValue === 'object' && !('value' in targetValue))) {
        missingKeys[key] = {
          value: details,
          sourceKey: key
        };
      }
      continue;
    }

    if (
      typeof details === 'object' && details !== null &&
      typeof details.value === 'string' &&
      (details.value.toLowerCase().includes('wip_') || details.value.toLowerCase().includes('_wip') ||
        details.value.toLowerCase().includes('__skip_translation__'))
    ) {
      skippedKeys[key] = {
        ...details,
        reason: 'wip'
      };
      continue;
    }

    if (!targetKeys[key]) {
      if (typeof details === 'object' && details !== null && 'value' in details) {
        missingKeys[key] = {
          ...details,
          sourceKey: key
        };
      } else {
        missingKeys[key] = {
          value: details,
          sourceKey: key
        };
      }
    }
  }

  return { missingKeys, skippedKeys };
}

/**
 * Find all missing translations grouped by locale and source file
 * @param sourceFiles Array of source translation files
 * @param targetFilesByLocale Record of target files grouped by locale
 * @param config Project configuration with sourceLocale and outputLocales
 * @param verbose Whether to show verbose output
 * @param logger Optional logger for console output
 * @returns Record of missing translations by locale and source file
 */
export function findMissingTranslationsByLocale(
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: { sourceLocale: string; outputLocales: string[] },
  verbose: boolean,
  logger: { log: (message?: any, ...optionalParams: any[]) => void } = console
): Record<string, MissingLocaleEntry> {
  const missingByLocale: Record<string, MissingLocaleEntry> = {};

  for (const sourceFile of sourceFiles) {
    if (!sourceFile.content) continue;

    const sourceContentRaw = Buffer.from(sourceFile.content, 'base64').toString();
    const sourceContent = parseFile(sourceContentRaw, sourceFile.format, sourceFile.path);
    const sourceWrapper = sourceContent[config.sourceLocale];
    const sourceKeys = flattenTranslations(
      sourceWrapper && typeof sourceWrapper === 'object' && !Array.isArray(sourceWrapper)
        ? sourceWrapper
        : sourceContent
    );

    for (const targetLocale of config.outputLocales) {
      const targetFiles = targetFilesByLocale[targetLocale] || [];
      const result = processLocaleTranslations(sourceKeys, targetLocale, targetFiles, sourceFile, config.sourceLocale);

      if (Object.keys(result.missingKeys).length > 0) {
        const sourceFilePath = sourceFile.path;
        const localeSourceKey = `${targetLocale}:${sourceFilePath}`;

        // Create or update the entry for this locale and source file
        if (!missingByLocale[localeSourceKey]) {
          missingByLocale[localeSourceKey] = {
            locale: targetLocale,
            path: sourceFilePath,
            targetPath: result.targetPath,
            keys: {},
            keyCount: 0
          };
        }

        // Now it's safe to update since we made sure it exists
        const entry = missingByLocale[localeSourceKey];
        entry.keys = {
          ...entry.keys,
          ...result.missingKeys
        };
        entry.keyCount = (entry.keyCount || 0) + Object.keys(result.missingKeys).length;
      }

      if (verbose && Object.keys(result.skippedKeys).length > 0) {
        logger.log(`\nℹ Skipped ${Object.keys(result.skippedKeys).length} keys marked as WIP in ${sourceFile.path}`);
      }
    }
  }

  return missingByLocale;
}

/**
 * Batch missing keys by source file (optimized for unique key sets)
 * @param sourceFiles Array of source translation files
 * @param missingByLocale Record of missing keys by locale and source file
 * @returns Result containing batches and errors
 */
export function batchKeysWithMissing(
  sourceFiles: TranslationFile[],
  missingByLocale: Record<string, MissingLocaleEntry>
): BatchResult {
  const MAX_BATCH_SIZE = 200;
  const batches: TranslationBatch[] = [];
  const errors: BatchError[] = [];

  interface SourceFileData {
    localeEntries: string[];
    locales: Set<string>;
    keys: Record<string, Record<string, any>>;
  }

  const entriesBySourceFile: Record<string, SourceFileData> = {};

  // Group entries by source file (back to original approach for predictable behavior)
  for (const [localeSourceKey, entry] of Object.entries(missingByLocale)) {
    const { path: sourceFilePath } = entry;

    if (!entriesBySourceFile[sourceFilePath]) {
      entriesBySourceFile[sourceFilePath] = {
        localeEntries: [],
        locales: new Set(),
        keys: {}
      };
    }

    entriesBySourceFile[sourceFilePath].localeEntries.push(localeSourceKey);
    entriesBySourceFile[sourceFilePath].locales.add(entry.locale);

    for (const [key, value] of Object.entries(entry.keys)) {
      if (!entriesBySourceFile[sourceFilePath].keys[key]) {
        entriesBySourceFile[sourceFilePath].keys[key] = {};
      }
      entriesBySourceFile[sourceFilePath].keys[key][entry.locale] = value;
    }
  }

  // Process each source file
  for (const [sourceFilePath, data] of Object.entries(entriesBySourceFile)) {
    const sourceFile = sourceFiles.find(f => f.path === sourceFilePath);

    if (!sourceFile) {
      errors.push({
        type: 'missing_source_file',
        message: `No source file found for path: ${sourceFilePath}`,
        path: sourceFilePath
      });
      continue;
    }

    const allKeys = Object.entries(data.keys);
    const chunkedKeys: Array<Array<[string, Record<string, TranslationValue>]>> = [];

    for (let i = 0; i < allKeys.length; i += MAX_BATCH_SIZE) {
      chunkedKeys.push(allKeys.slice(i, i + MAX_BATCH_SIZE));
    }

    for (const keyChunk of chunkedKeys) {
      const contentObj: { keys: Record<string, TranslationWithMetadata | { value: TranslationPrimitiveValue }> } = { keys: {} };

      for (const [key, translations] of keyChunk) {
        const value: TranslationValue = Object.values(translations)[0];

        contentObj.keys[key] = typeof value === 'object' && value !== null && 'value' in value
          ? value
          : { value: extractPrimitiveValue(value) };
      }

      batches.push({
        sourceFilePath,
        sourceFile: {
          path: sourceFile.path,
          format: sourceFile.format,
          content: Buffer.from(JSON.stringify(contentObj)).toString('base64')
        },
        localeEntries: data.localeEntries,
        locales: Array.from(data.locales)
      });
    }
  }

  return { batches, errors };
}

/**
 * Find a target file that corresponds to the source file
 * @param targetFiles Array of target translation files
 * @param targetLocale The target locale
 * @param sourceFile The source file
 * @param sourceLocale The source locale
 * @returns The matching target file, or undefined if not found
 */
export function findTargetFile(
  targetFiles: TranslationFile[],
  targetLocale: string,
  sourceFile: TranslationFile,
  sourceLocale: string
): TranslationFile | undefined {
  // First try exact directory matching (existing logic)
  let found = targetFiles.find(f =>
    f.locale === targetLocale &&
    path.dirname(f.path) === path.dirname(sourceFile.path) &&
    path.basename(f.path, path.extname(f.path)) === path.basename(sourceFile.path, path.extname(sourceFile.path)).replace(sourceLocale, targetLocale)
  );

  if (found) return found;

  // Then try filename-based matching regardless of directory (existing logic)
  found = targetFiles.find(f =>
    f.locale === targetLocale &&
    path.basename(f.path, path.extname(f.path)) === path.basename(sourceFile.path, path.extname(sourceFile.path)).replace(sourceLocale, targetLocale)
  );

  if (found) return found;

  const sourceDirParts = path.dirname(sourceFile.path).split(path.sep);
  const sourceFileBaseName = path.basename(sourceFile.path, path.extname(sourceFile.path));

  // Check for corresponding file in subdirectories or parent directories
  return targetFiles.find(f => {
    if (f.locale !== targetLocale) return false;

    // Handle cases where files are in different subdirectories
    const targetDirParts = path.dirname(f.path).split(path.sep);
    const targetFileBaseName = path.basename(f.path, path.extname(f.path));

    if (
      sourceFileBaseName === sourceLocale &&
      targetFileBaseName === targetLocale &&
      sourceDirParts.length === targetDirParts.length
    ) {
      return true;
    }

    // Nested directory structure
    if (sourceDirParts.includes(sourceLocale) && targetDirParts.includes(targetLocale)) {
      const sourceBasePath = sourceDirParts.slice(0, sourceDirParts.indexOf(sourceLocale)).join(path.sep);
      const targetBasePath = targetDirParts.slice(0, targetDirParts.indexOf(targetLocale)).join(path.sep);

      return sourceBasePath === targetBasePath &&
        sourceFileBaseName === targetFileBaseName;
    }

    return false;
  });
}

/**
 * Generate a target file path based on source file and locales
 * @param sourceFile The source translation file
 * @param targetLocale The target locale
 * @param sourceLocale The source locale
 * @returns The generated target file path
 */
export function generateTargetPath(
  sourceFile: TranslationFile,
  targetLocale: string,
  sourceLocale: string
): string {
  const sourceExt = path.extname(sourceFile.path);
  const sourceDir = path.dirname(sourceFile.path);
  const sourceName = path.basename(sourceFile.path, sourceExt);

  // Case 1: File is named exactly as the source locale (e.g., "en.yml")
  if (sourceName === sourceLocale) {
    return path.join(sourceDir, `${targetLocale}${sourceExt}`);
  }

  // Case 2: File ends with .locale (e.g., "translations.en.yml")
  if (sourceName.endsWith(`.${sourceLocale}`)) {
    const baseName = sourceName.slice(0, -(sourceLocale.length + 1));
    return path.join(sourceDir, `${baseName}.${targetLocale}${sourceExt}`);
  }

  // Case 3: File uses hyphen-locale format (e.g., "translations-en.yml")
  if (sourceName.includes(`-${sourceLocale}`)) {
    const baseName = sourceName.slice(0, -(sourceLocale.length + 1));
    return path.join(sourceDir, `${baseName}-${targetLocale}${sourceExt}`);
  }

  // Case 4: Source locale is a directory name
  const sourceParentDir = path.basename(sourceDir);
  if (sourceParentDir === sourceLocale) {
    const grandParentDir = path.dirname(sourceDir);
    return path.join(grandParentDir, targetLocale, path.basename(sourceFile.path));
  }

  // Default case: If none of the above patterns match,
  // construct the target path by replacing the locale in the filename only
  const dirPath = path.dirname(sourceFile.path);
  const fileName = path.basename(sourceFile.path);
  const localeRegex = new RegExp(`\\b${sourceLocale}\\b`, 'g');
  const newFileName = fileName.replace(localeRegex, targetLocale);
  return path.join(dirPath, newFileName);
}

/**
 * Process target content to extract translation keys
 * @param targetContent The target content object
 * @param targetLocale The target locale
 * @returns Flattened translations
 */
export function processTargetContent(
  targetContent: Record<string, any>,
  targetLocale: string
): Record<string, any> {
  if (targetContent[targetLocale]) {
    return flattenTranslations(targetContent[targetLocale]);
  }
  return flattenTranslations(targetContent);
}

/**
 * Interface for the result of processing locale translations
 */
export interface ProcessLocaleResult {
  targetPath: string;
  missingKeys: Record<string, SourceKeyDetails>;
  skippedKeys: Record<string, SkippedKeyDetails>;
  targetFile?: TranslationFile;
}

/**
 * Process translations for a specific locale
 * @param sourceKeys The source translation keys
 * @param targetLocale The target locale
 * @param targetFiles Array of target translation files
 * @param sourceFile The source file
 * @param sourceLocale The source locale
 * @returns Result with target path and missing/skipped keys
 */
export function processLocaleTranslations(
  sourceKeys: Record<string, any>,
  targetLocale: string,
  targetFiles: TranslationFile[],
  sourceFile: TranslationFile,
  sourceLocale: string
): ProcessLocaleResult {
  try {
    const targetFile = findTargetFile(targetFiles, targetLocale, sourceFile, sourceLocale);
    let targetKeys: Record<string, any> = {};
    let targetPath = '';

    if (targetFile) {
      const targetContentRaw = Buffer.from(targetFile.content || '', 'base64').toString();
      const targetContent = parseFile(targetContentRaw, targetFile.format, targetFile.path);
      targetKeys = processTargetContent(targetContent, targetLocale);
      targetPath = targetFile.path;
    } else {
      targetPath = generateTargetPath(sourceFile, targetLocale, sourceLocale);
    }

    // Use .po-specific missing detection for .po/.pot files
    const isPoFile = sourceFile.path.endsWith('.po') || sourceFile.path.endsWith('.pot') ||
                      targetPath.endsWith('.po') || targetPath.endsWith('.pot');
    let missingKeys: Record<string, SourceKeyDetails> = {};
    let skippedKeys: Record<string, SkippedKeyDetails> = {};

    if (isPoFile && sourceFile.content && targetFile?.content) {
      const sourceContentRaw = Buffer.from(sourceFile.content, 'base64').toString();
      const targetContentRaw = Buffer.from(targetFile.content, 'base64').toString();
      const missingPoTranslations = findMissingPoTranslations(sourceContentRaw, targetContentRaw);

      // Convert the .po missing results to the expected format
      missingPoTranslations.forEach(missing => {
        const key = missing.isPlural
          ? missing.key
          : (missing.context ? createUniqueKey(missing.key, missing.context) : missing.key);

        // Extract plural index from key name (e.g., "book__plural_2" -> 2)
        const pluralMatch = missing.key.match(new RegExp(`${PLURAL_PREFIX}(\\d+)$`));
        const pluralIndex = pluralMatch ? parseInt(pluralMatch[1]) : 0;

        // Extract base msgid for plural forms (remove __plural_X suffix)
        const baseMsgid = missing.key.replace(new RegExp(`${PLURAL_PREFIX}\\d+$`), '');

        const entryData: any = {
          value: missing.value,
          sourceKey: key,
          context: missing.context
        };

        if (missing.isPlural) {
          entryData.metadata = {
            po_plural: true,
            plural_index: pluralIndex
          };

          // Add msgid_plural to first form (index 0), msgid to others
          if (pluralIndex === 0) {
            entryData.metadata.msgid_plural = missing.pluralForm;
          } else {
            entryData.metadata.msgid = baseMsgid;
          }
        }

        missingKeys[key] = entryData;
      });
    } else {
      // For other file types (yml, json), use the generic missing detection
      const result = findMissingTranslations(sourceKeys, targetKeys);
      missingKeys = result.missingKeys;
      skippedKeys = result.skippedKeys;
    }

    return {
      targetPath,
      missingKeys,
      skippedKeys,
      targetFile
    };
  } catch (error: any) {
    throw new Error(`Failed to process translations for ${targetLocale}: ${error.message}`);
  }
}
