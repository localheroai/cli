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

  // Build keyMappings for PO versioning (old key → new key)
  const keyMappings: Record<string, string> = {};
  let stringTranslations: Record<string, string>;

  if (Array.isArray(translations)) {
    // Sync mode: array of SyncTranslation objects with metadata
    stringTranslations = {};
    for (const item of translations) {
      const value = typeof item.value === 'string' ? item.value : String(item.value);
      stringTranslations[item.key] = value;

      for (const oldValue of item.old_values ?? []) {
        keyMappings[oldValue.key] = item.key;
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

  const hasKeyMappings = Object.keys(keyMappings).length > 0;
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
      keyMappings: hasKeyMappings ? keyMappings : undefined
    });

    if (updatedContent !== originalContent) {
      updatedKeys = Object.keys(stringTranslations);
      await writeFile(filePath, updatedContent, 'utf-8');
    }
  } else {
    created = true;
    updatedKeys = Object.keys(stringTranslations);

    if (sourceFilePath && await fileExists(sourceFilePath)) {
      const sourceContent = await readFile(sourceFilePath, 'utf-8');
      const updatedContent = surgicalUpdatePoFile(sourceContent, stringTranslations, {
        sourceLanguage,
        targetLanguage: languageCode,
        sourceContent,
        keyMappings: hasKeyMappings ? keyMappings : undefined
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