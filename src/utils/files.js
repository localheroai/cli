import chalk from 'chalk';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { promises as fs } from 'fs';

export function parseFile(content, format, filePath = '') {
  try {
    if (format === 'json') {
      try {
        return JSON.parse(content);
      } catch (jsonError) {
        const errorInfo = jsonError.message.match(/at position (\d+)/)
          ? jsonError.message
          : `${jsonError.message} (check for missing commas, quotes, or brackets)`;
        throw new Error(errorInfo);
      }
    }
    return yaml.parse(content);
  } catch (error) {
    const location = filePath ? ` in ${filePath}` : '';
    throw new Error(`Failed to parse ${format} file${location}: ${error.message}`);
  }
}

export function extractLocaleFromPath(filePath, localeRegex, knownLocales = []) {
  if (knownLocales && knownLocales.length > 0) {
    const basename = path.basename(filePath, path.extname(filePath));
    const foundLocaleInFilename = knownLocales.find(locale =>
      locale && basename.toLowerCase() === locale.toLowerCase()
    );
    if (foundLocaleInFilename) {
      return foundLocaleInFilename.toLowerCase();
    }

    // Then try to match in the path
    const pathParts = filePath.toLowerCase().split(path.sep);
    const foundLocaleInPath = knownLocales.find(locale =>
      locale && pathParts.includes(locale.toLowerCase())
    );
    if (foundLocaleInPath) {
      return foundLocaleInPath.toLowerCase();
    }
  }

  const dirName = path.basename(path.dirname(filePath));
  if (dirName && isValidLocale(dirName)) {
    return dirName.toLowerCase();
  }

  if (localeRegex) {
    const filename = path.basename(filePath);
    const regexPattern = new RegExp(localeRegex);
    const regexMatch = filename.match(regexPattern);
    if (regexMatch && regexMatch[1]) {
      const locale = regexMatch[1].toLowerCase();
      if (isValidLocale(locale)) {
        return locale;
      }
    }
  }

  throw new Error(`Could not extract locale from path: ${filePath}`);
}

export function isValidLocale(locale) {
  // Basic validation for language code (2 letters) or language-region code (e.g., en-US)
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale);
}

export function flattenTranslations(obj, parentKey = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = parentKey ? `${parentKey}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenTranslations(value, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function detectJsonFormat(obj) {
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

function unflattenTranslations(flatObj) {
  const result = {};

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

function preserveJsonStructure(originalObj, newTranslations, format) {
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

function deepMerge(target, source) {
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

function extractNamespace(filePath) {
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

export async function findTranslationFiles(config, options = {}) {
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

  const processedFiles = [];

  for (const translationPath of paths) {
    const fullPath = path.join(basePath, translationPath);
    const globPattern = path.join(fullPath, pattern);

    if (verbose) {
      console.log(chalk.blue(`Searching for translation files in ${globPattern}`));
    }

    let files;
    try {
      files = await glob(globPattern, {
        ignore: ignore.map(i => path.join(basePath, i)),
        absolute: false
      });

      if (verbose) {
        console.log(chalk.blue(`Found ${files.length} files in ${translationPath}`));
      }
    } catch (error) {
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

        const result = {
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
            const hasLanguageWrapper = parsedContent[locale] !== undefined;
            result.hasLanguageWrapper = hasLanguageWrapper;
            const translationData = hasLanguageWrapper ? parsedContent[locale] : parsedContent;
            result.translations = translationData;
            result.keys = flattenTranslations(translationData);
          }
        }

        if (includeNamespace) {
          result.namespace = extractNamespace(filePath);
        }

        processedFiles.push(result);
      } catch (error) {
        if (error.message.includes('Failed to parse') ||
          error.message.includes('JSON') ||
          error.message.includes('Unexpected token') ||
          error.message.includes('Missing closing')) {
          console.warn(chalk.yellow(`\nWarning: ${error.message}`));

          if (format === 'json') {
            console.warn(chalk.gray('  Tip: Check for missing commas, quotes, or brackets in your JSON file.'));
          } else if (format === 'yml' || format === 'yaml') {
            console.warn(chalk.gray('  Tip: Check for proper indentation and quote matching in your YAML file.'));
          }
        } else if (verbose) {
          console.warn(chalk.yellow(`Warning: ${error.message}`));
        }
      }
    }
  }

  if (!returnFullResult) {
    return processedFiles;
  }

  const allFiles = processedFiles;
  const sourceFiles = allFiles.filter(file => file.locale === sourceLocale);
  const targetFilesByLocale = {};

  for (const locale of targetLocales) {
    targetFilesByLocale[locale] = allFiles.filter(file => file.locale === locale);
  }

  return {
    allFiles,
    sourceFiles,
    targetFilesByLocale
  };
}

export {
  unflattenTranslations,
  detectJsonFormat,
  preserveJsonStructure,
  directoryExists,
  findFirstExistingPath,
  getDirectoryContents
};

async function directoryExists(path, fsModule = fs) {
  try {
    const stats = await fsModule.stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function findFirstExistingPath(paths, fsModule = fs) {
  for (const path of paths) {
    if (await directoryExists(path, fsModule)) {
      return path;
    }
  }
  return null;
}

async function getDirectoryContents(dir, fsModule = fs) {
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