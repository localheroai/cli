import { readFile, writeFile } from 'fs/promises';
import { fileExists } from './common.js';
import { parseUniqueKey, parsePoFile, createPoFile } from '../po-utils.js';
import { surgicalUpdatePoFile } from '../po-surgical.js';
import type { TranslationWithMetadata } from '../../types/index.js';

/**
 * Updates a .po file with new translations
 */
export async function updatePoFile(
  filePath: string,
  translations: Record<string, unknown> | TranslationWithMetadata[],
  languageCode: string = 'en',
  sourceFilePath: string | null = null,
  sourceLanguage?: string
): Promise<{ created: boolean; updatedKeys: string[] }> {
  let created = false;
  const fileAlreadyExists = await fileExists(filePath);

  // Build keyMappings for PO versioning (new key → old key)
  const keyMappings: Record<string, string> = {};
  let stringTranslations: Record<string, string>;

  if (Array.isArray(translations)) {
    // Sync mode: array of SyncTranslation objects with metadata
    stringTranslations = {};
    for (const item of translations) {
      const value = typeof item.value === 'string' ? item.value : String(item.value);
      stringTranslations[item.key] = value;

      // If this translation has old_values, map new key to old key
      if (item.old_values && item.old_values.length > 0) {
        const oldKey = item.old_values[0].key;
        keyMappings[item.key] = oldKey;
      }
    }
  } else {
    // Regular mode: Record<string, unknown>
    stringTranslations = Object.fromEntries(
      Object.entries(translations).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : String(value)
      ])
    );
  }

  let updatedKeys: string[] = [];

  if (fileAlreadyExists) {
    const originalContent = await readFile(filePath, 'utf-8');

    // Get source content if available for proper msgid_plural lookup
    let sourceContent: string | undefined;
    if (sourceFilePath && await fileExists(sourceFilePath)) {
      sourceContent = await readFile(sourceFilePath, 'utf-8');
    }

    const updatedContent = surgicalUpdatePoFile(originalContent, stringTranslations, {
      sourceLanguage,
      targetLanguage: languageCode,
      sourceContent,
      keyMappings: Object.keys(keyMappings).length > 0 ? keyMappings : undefined
    });

    // Check if content actually changed
    if (updatedContent !== originalContent) {
      // For .po files with surgical updates, if content changed, assume all provided keys were updated
      // This is a simplified approach - could be made more precise by having surgicalUpdatePoFile return changed keys
      updatedKeys = Object.keys(stringTranslations);
      await writeFile(filePath, updatedContent, 'utf-8');
    }
  } else {
    created = true;
    // New file - all translations are "updates"
    updatedKeys = Object.keys(stringTranslations);

    if (sourceFilePath && await fileExists(sourceFilePath)) {
      // Copy structure from source file preserving original headers
      const sourceContent = await readFile(sourceFilePath, 'utf-8');
      const updatedContent = surgicalUpdatePoFile(sourceContent, stringTranslations, {
        sourceLanguage,
        targetLanguage: languageCode,
        sourceContent,
        keyMappings: Object.keys(keyMappings).length > 0 ? keyMappings : undefined
      });

      await writeFile(filePath, updatedContent, 'utf-8');
    } else {
      // Create minimal .po file structure
      const entries = Object.entries(stringTranslations).map(([key, value]) => {
        const { msgid, context } = parseUniqueKey(key);
        return {
          msgid,
          msgstr: [value],
          msgctxt: context,
          msgid_plural: undefined,
          comments: undefined
        };
      });

      const headers = {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Language': languageCode
      };

      const poContent = createPoFile(entries, headers);
      await writeFile(filePath, poContent, 'utf-8');
    }
  }

  return { created, updatedKeys };
}

/**
 * Removes keys from a .po file
 */
export async function deleteKeysFromPoFile(
  filePath: string,
  keysToDelete: string[]
): Promise<void> {
  if (!await fileExists(filePath)) {
    return;
  }

  const originalContent = await readFile(filePath, 'utf-8');
  const parsed = parsePoFile(originalContent);
  const deleteSet = new Set(keysToDelete);

  const filteredEntries = parsed.entries.filter(entry => {
    const uniqueKey = entry.msgctxt
      ? `${entry.msgctxt}|${entry.msgid}`
      : entry.msgid;
    return !deleteSet.has(uniqueKey);
  });

  const updatedContent = createPoFile(filteredEntries, parsed.headers);
  await writeFile(filePath, updatedContent, 'utf-8');
}