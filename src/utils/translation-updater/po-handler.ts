import { readFile, writeFile } from 'fs/promises';
import { fileExists } from './common.js';
import { updatePoFile as updatePoContent, parseUniqueKey, parsePoFile, createPoFile } from '../po-utils.js';

/**
 * Updates a .po file with new translations
 */
export async function updatePoFile(
  filePath: string,
  translations: Record<string, unknown>,
  languageCode: string = 'en',
  sourceFilePath: string | null = null
): Promise<{ created: boolean }> {
  let created = false;
  const fileAlreadyExists = await fileExists(filePath);
  const stringTranslations = Object.fromEntries(
    Object.entries(translations).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : String(value)
    ])
  );

  if (fileAlreadyExists) {
    const originalContent = await readFile(filePath, 'utf-8');
    const updatedContent = updatePoContent(originalContent, stringTranslations);
    await writeFile(filePath, updatedContent, 'utf-8');
  } else {
    created = true;

    if (sourceFilePath && await fileExists(sourceFilePath)) {
      // Copy structure from source file preserving original headers
      const sourceContent = await readFile(sourceFilePath, 'utf-8');
      const updatedContent = updatePoContent(sourceContent, stringTranslations);

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

  return { created };
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