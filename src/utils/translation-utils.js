import path from 'path';
import { flattenTranslations, parseFile } from './files.js';

export function findMissingTranslations(sourceKeys, targetKeys) {
  const missingKeys = {};
  const skippedKeys = {};

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
      if (!targetKeys[key]) {
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


export function batchKeysWithMissing(sourceFiles, missingByLocale, batchSize = 100) {
  const batches = [];
  const errors = [];
  const sourceFileEntries = new Map();

  for (const [locale, localeData] of Object.entries(missingByLocale)) {
    const sourceFile = sourceFiles.find(f => f.path === localeData.path);
    if (!sourceFile) {
      errors.push({
        type: 'missing_source_file',
        message: `No source file found for path: ${localeData.path}`,
        locale,
        path: localeData.path
      });
      continue;
    }

    if (!sourceFileEntries.has(sourceFile.path)) {
      sourceFileEntries.set(sourceFile.path, {
        path: sourceFile.path,
        format: sourceFile.format || 'json',
        keys: {},
        locales: new Set()
      });
    }

    const entry = sourceFileEntries.get(sourceFile.path);

    const formattedKeys = {};
    for (const [key, value] of Object.entries(localeData.keys)) {
      let extractedValue;

      if (Array.isArray(value)) {
        extractedValue = value;
      } else if (typeof value === 'boolean') {
        extractedValue = value;
      } else if (typeof value === 'string') {
        extractedValue = value;
      } else if (typeof value === 'object' && value !== null) {
        if ('value' in value) {
          extractedValue = value.value;
        } else if (Object.keys(value).some(k => !isNaN(parseInt(k, 10)))) {
          extractedValue = Object.values(value).join('');
        } else {
          extractedValue = JSON.stringify(value);
        }
      } else {
        extractedValue = String(value);
      }

      formattedKeys[key] = extractedValue;
    }

    entry.keys = { ...entry.keys, ...formattedKeys };
    entry.locales.add(locale);
  }

  for (const entry of sourceFileEntries.values()) {
    const keyEntries = Object.entries(entry.keys);

    for (let i = 0; i < keyEntries.length; i += batchSize) {
      const batchKeys = Object.fromEntries(keyEntries.slice(i, i + batchSize));

      const contentObj = { keys: {} };
      for (const [key, value] of Object.entries(batchKeys)) {
        contentObj.keys[key] = {
          value
        };
      }

      batches.push({
        files: [{
          path: entry.path,
          format: entry.format,
          content: Buffer.from(JSON.stringify(contentObj)).toString('base64')
        }],
        locales: Array.from(entry.locales)
      });
    }
  }

  return { batches, errors };
}

export function findTargetFile(targetFiles, targetLocale, sourceFile, sourceLocale) {
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

export function generateTargetPath(sourceFile, targetLocale, sourceLocale) {
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

export function processTargetContent(targetContent, targetLocale) {
  if (targetContent[targetLocale]) {
    return flattenTranslations(targetContent[targetLocale]);
  }
  return flattenTranslations(targetContent);
}

export function processLocaleTranslations(sourceKeys, targetLocale, targetFiles, sourceFile, sourceLocale) {
  try {
    const targetFile = findTargetFile(targetFiles, targetLocale, sourceFile, sourceLocale);
    let targetKeys = {};
    let targetPath = '';

    if (targetFile) {
      const targetContentRaw = Buffer.from(targetFile.content, 'base64').toString();
      const targetContent = parseFile(targetContentRaw, targetFile.format);
      targetKeys = processTargetContent(targetContent, targetLocale);
      targetPath = targetFile.path;
    } else {
      targetPath = generateTargetPath(sourceFile, targetLocale, sourceLocale);
    }

    const { missingKeys, skippedKeys } = findMissingTranslations(sourceKeys, targetKeys);

    return {
      targetPath,
      missingKeys,
      skippedKeys,
      targetFile
    };
  } catch (error) {
    throw new Error(`Failed to process translations for ${targetLocale}: ${error.message}`);
  }
}
