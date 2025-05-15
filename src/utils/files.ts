import chalk from 'chalk';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { promises as fs } from 'fs';
import type {
  TranslationConfig,
  TranslationFile,
  TranslationFilesResult,
  TranslationFileOptions
} from '../types/index.js';


/**
 * Parse file content based on format
 */
export function parseFile(content: string, format: string, filePath: string = ''): Record<string, any> {
  try {
    if (format === 'json') {
      try {
        return JSON.parse(content);
      } catch (jsonError: any) {
        const errorInfo = jsonError.message.match(/at position (\d+)/)
          ? jsonError.message
          : `${jsonError.message} (check for missing commas, quotes, or brackets)`;
        throw new Error(errorInfo);
      }
    }
    return yaml.parse(content);
  } catch (error: any) {
    const location = filePath ? ` in ${filePath}` : '';
    throw new Error(`Failed to parse ${format} file${location}: ${error.message}`);
  }
}

/**
 * Extract locale from file path
 */
function extractLocaleFromPath(filePath: string, localeRegex?: string, knownLocales: string[] = []): string {
  if (knownLocales && knownLocales.length > 0) {
    const basenameOriginal = path.basename(filePath, path.extname(filePath));
    const isBasenameAKnownLocale = knownLocales.some(
      (kl) => kl && basenameOriginal.toLowerCase() === kl.toLowerCase()
    );
    if (isBasenameAKnownLocale) {
      if (isValidLocale(basenameOriginal)) {
        if (basenameOriginal.length === 2) {
          return basenameOriginal.toLowerCase();
        }
        return basenameOriginal;
      }
    }

    const originalPathParts = filePath.split(path.sep);
    for (const part of originalPathParts) {
      const isPartAKnownLocale = knownLocales.some(
        (kl) => kl && part.toLowerCase() === kl.toLowerCase()
      );
      if (isPartAKnownLocale) {
        if (isValidLocale(part)) {
          if (part.length === 2) {
            return part.toLowerCase();
          }
          return part;
        }
      }
    }
  }

  const dirNameOriginal = path.basename(path.dirname(filePath));
  if (dirNameOriginal && isValidLocale(dirNameOriginal)) {
    return dirNameOriginal;
  }

  if (localeRegex) {
    const filenameOriginal = path.basename(filePath);
    const regexPattern = new RegExp(localeRegex);
    const regexMatch = filenameOriginal.match(regexPattern);
    if (regexMatch && regexMatch[1]) {
      const capturedLocale = regexMatch[1];
      if (isValidLocale(capturedLocale)) {
        return capturedLocale;
      }
    }
  }

  throw new Error(`Could not extract locale from path: ${filePath}`);
}

/**
 * Check if locale is valid
 */
export function isValidLocale(locale: string): boolean {
  // Basic validation for language code (2 letters) or language-region code (e.g., en-US or en-us)
  // Case insensitive for better compatibility with existing code
  return /^[a-zA-Z]{2}(?:-[a-zA-Z]{2})?$/.test(locale);
}

/**
 * Flatten a nested object into dot notation
 * Handles null/undefined values by returning an empty object
 */
export function flattenTranslations(obj: Record<string, any> | null | undefined, parentKey: string = ''): Record<string, any> {
  const result: Record<string, any> = {};

  if (!obj) {
    return result;
  }

  for (const [key, value] of Object.entries(obj)) {
    const newKey = parentKey ? `${parentKey}.${key}` : key;

    if (value === null || value === undefined) {
      result[newKey] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenTranslations(value, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Detect the format of a JSON translation file
 */
export function detectJsonFormat(obj: Record<string, any>): 'flat' | 'nested' | 'mixed' {
  let hasNested = false;
  let hasDotNotation = false;

  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('.')) {
      hasDotNotation = true;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      hasNested = true;

      for (const [, nestedValue] of Object.entries(value)) {
        if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
          return 'nested';
        }
      }
    }
  }

  if (hasNested && hasDotNotation) {
    return 'mixed';
  } else if (hasNested) {
    return 'nested';
  } else if (hasDotNotation) {
    return 'flat';
  }

  return 'flat';
}

/**
 * Convert a flattened object back to nested structure
 */
export function unflattenTranslations(flatObj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(flatObj)) {
    const keys = key.split('.');
    let current = result;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      current[k] = current[k] || {};
      current = current[k];
    }

    current[keys[keys.length - 1]] = value;
  }

  return result;
}

/**
 * Preserve the original structure of a JSON object when adding new translations
 */
export function preserveJsonStructure(
  originalObj: Record<string, any>,
  newTranslations: Record<string, any>,
  format: 'flat' | 'nested' | 'mixed'
): Record<string, any> {
  if (format === 'flat') {
    return { ...originalObj, ...newTranslations };
  }

  if (format === 'nested') {
    const merged = { ...originalObj };
    const unflattenedNew = unflattenTranslations(newTranslations);
    return deepMerge(merged, unflattenedNew);
  }

  const result = { ...originalObj };

  for (const [key, value] of Object.entries(newTranslations)) {
    if (key.includes('.')) {
      const keys = key.split('.');
      if (originalObj[key] !== undefined) {
        result[key] = value;
        continue;
      }

      let current = result;

      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        current[k] = current[k] || {};
        if (typeof current[k] !== 'object' || Array.isArray(current[k])) {
          current[k] = {};
        }

        current = current[k];
      }

      current[keys[keys.length - 1]] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Deep merge two objects
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' &&
      result[key] && typeof result[key] === 'object' &&
      !Array.isArray(value) && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract namespace from file path
 */
function extractNamespace(filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  const dirName = path.basename(path.dirname(filePath));

  // Pattern 1: /path/to/en/common.json -> namespace = common
  if (/^[a-z]{2}(-[A-Z]{2})?$/.test(dirName)) {
    return fileName;
  }

  // Pattern 2: /path/to/messages.en.json -> namespace = messages
  const dotMatch = fileName.match(/^(.+)\.([a-z]{2}(?:-[A-Z]{2})?)$/);
  if (dotMatch) {
    return dotMatch[1];
  }

  // Pattern 3: /path/to/common-en.json -> namespace = common
  const dashMatch = fileName.match(/^(.+)-([a-z]{2}(?:-[A-Z]{2})?)$/);
  if (dashMatch) {
    return dashMatch[1];
  }

  return '';
}

/**
 * Find and process translation files based on configuration
 */
export async function findTranslationFiles(
  config: TranslationConfig,
  options: TranslationFileOptions = {}
): Promise<TranslationFile[] | TranslationFilesResult> {
  const {
    parseContent = true,
    includeContent = true,
    extractKeys = true,
    basePath = process.cwd(),
    sourceLocale = config.sourceLocale,
    targetLocales = config.outputLocales || [],
    includeNamespace = false,
    verbose = false,
    returnFullResult = false
  } = options;

  const knownLocales = [sourceLocale, ...targetLocales];
  const { translationFiles } = config;
  const {
    paths = [],
    pattern = '**/*.{json,yml,yaml}',
    ignore = [],
    localeRegex = '.*?([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
  } = translationFiles || {};

  const processedFiles: TranslationFile[] = [];

  // Adjustment to handle single-item braces, common mistake to use {json} instead of *.json, its not supported by glob
  const adjustPattern = (originalPattern: string): string => {
    if (!originalPattern.includes(',')) {
      const singleItemBraceRegex = /\.\{([^{},]+)\}/g;
      const newPattern = originalPattern.replace(singleItemBraceRegex, '.$1');
      if (newPattern !== originalPattern && verbose) {
        console.log(chalk.blue(`ℹ Adjusted glob pattern from "${originalPattern}" to "${newPattern}" to handle single-item brace notation.`));
      }
      return newPattern;
    }

    return originalPattern;
  };

  const adjustedPattern = adjustPattern(pattern);

  for (const translationPath of paths) {
    const fullPath = path.join(basePath, translationPath);
    const globPattern = path.join(fullPath, adjustedPattern);

    if (verbose) {
      console.log(chalk.blue(`Searching for translation files in ${globPattern}`));
    }

    let files: string[];
    try {
      files = await glob(globPattern, {
        ignore: ignore.map(i => path.join(basePath, i)),
        absolute: false,
        follow: true
      });

      if (verbose) {
        console.log(chalk.blue(`Found ${files.length} files in ${translationPath}`));
      }
    } catch (error: any) {
      if (verbose) {
        console.error(chalk.red(`Error searching for files in ${translationPath}: ${error.message}`));
      }
      files = [];
    }

    for (const file of files) {
      try {
        const filePath = file;
        const format = path.extname(file).slice(1);
        const locale = extractLocaleFromPath(file, localeRegex, knownLocales);

        const result: TranslationFile = {
          path: filePath,
          format,
          locale
        };

        if (parseContent) {
          const content = await readFile(filePath, 'utf8');
          const parsedContent = parseFile(content, format, filePath);

          if (includeContent) {
            result.content = Buffer.from(content).toString('base64');
          }

          if (extractKeys) {
            const hasLanguageWrapper = parsedContent && parsedContent[locale] !== undefined;
            result.hasLanguageWrapper = hasLanguageWrapper;
            const translationData = hasLanguageWrapper ? (parsedContent[locale] || {}) : (parsedContent || {});
            result.translations = translationData;
            const flattened = flattenTranslations(translationData);
            // @ts-expect-error - Keep original behavior for test compatibility
            result.keys = flattened;
          }
        }

        if (includeNamespace) {
          result.namespace = extractNamespace(filePath);
        }

        processedFiles.push(result);
      } catch (error: any) {
        if (error.message.includes('Failed to parse') ||
          error.message.includes('JSON') ||
          error.message.includes('Unexpected token') ||
          error.message.includes('Missing closing')) {
          console.warn(chalk.yellow(`\nWarning: ${error.message}`));

          const format = path.extname(file).slice(1);
          if (format === 'json') {
            console.warn(chalk.gray('  Tip: Check for missing commas, quotes, or brackets in your JSON file.'));
          } else if (format === 'yml' || format === 'yaml') {
            console.warn(chalk.gray('  Tip: Check for proper indentation and quote matching in your YAML file.'));
          }
        } else if (verbose) {
          console.warn(chalk.yellow(`Warning: ${error.message}`));
          console.error(chalk.dim(error.stack));
        }
      }
    }
  }

  if (!returnFullResult) {
    return processedFiles;
  }

  const allFiles = processedFiles;
  const sourceLocaleLower = sourceLocale ? sourceLocale.toLowerCase() : '';
  const sourceFiles = allFiles.filter(file => file.locale.toLowerCase() === sourceLocaleLower);

  const targetFilesByLocale: Record<string, TranslationFile[]> = {};

  for (const targetConfigLocale of targetLocales) {
    const targetConfigLocaleLower = targetConfigLocale ? targetConfigLocale.toLowerCase() : '';
    targetFilesByLocale[targetConfigLocale] = allFiles.filter(
      file => file.locale.toLowerCase() === targetConfigLocaleLower
    );
  }

  return {
    allFiles,
    sourceFiles,
    targetFilesByLocale
  };
}

/**
 * Check if a directory exists
 */
export async function directoryExists(dirPath: string, fsModule = fs): Promise<boolean> {
  try {
    const stats = await fsModule.stat(dirPath);
    return stats.isDirectory();
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Find the first existing path from a list of paths
 */
export async function findFirstExistingPath(paths: string[], fsModule = fs): Promise<string | null> {
  for (const path of paths) {
    if (await directoryExists(path, fsModule)) {
      return path;
    }
  }
  return null;
}

/**
 * Get contents of a directory, categorized by file type
 */
export interface DirectoryContents {
  files: string[];
  jsonFiles: string[];
  yamlFiles: string[];
}

export async function getDirectoryContents(dir: string, fsModule = fs): Promise<DirectoryContents | null> {
  try {
    const files = await fsModule.readdir(dir);
    return {
      files,
      jsonFiles: files.filter(f => f.endsWith('.json')),
      yamlFiles: files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    };
  } catch {
    return null;
  }
}
