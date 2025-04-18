import path from 'path';
import { fileExists, ensureDirectoryExists } from './common.js';
import { updateYamlFile, deleteKeysFromYamlFile } from './yaml-handler.js';
import { updateJsonFile, deleteKeysFromJsonFile } from './json-handler.js';

/**
 * Result of updating a translation file
 */
interface UpdateResult {
    updatedKeys: string[];
    created: boolean;
}

/**
 * Updates a translation file with new translations
 *
 * @param filePath Path to the file to update
 * @param translations Dictionary of translations to add/update
 * @param languageCode The language code (default: 'en')
 * @param sourceFilePath Optional path to source file (needed for new files)
 * @returns Information about the update operation
 */
export async function updateTranslationFile(
  filePath: string,
  translations: Record<string, unknown>,
  languageCode: string = 'en',
  sourceFilePath: string | null = null
): Promise<UpdateResult> {
  const fileExt = path.extname(filePath).slice(1).toLowerCase();
  const result: UpdateResult = {
    updatedKeys: Object.keys(translations),
    created: false
  };

  await ensureDirectoryExists(filePath);

  if (fileExt === 'json') {
    const jsonResult = await updateJsonFile(filePath, translations, languageCode, sourceFilePath);
    return {
      updatedKeys: result.updatedKeys,
      created: jsonResult.created
    };
  }

  return updateYamlFile(filePath, translations, languageCode);
}

/**
 * Deletes keys from a translation file
 *
 * @param filePath Path to the file to update
 * @param keysToDelete Array of dot-notation keys to delete
 * @param languageCode The language code (default: 'en')
 * @returns Array of keys that were successfully deleted
 */
export async function deleteKeysFromTranslationFile(
  filePath: string,
  keysToDelete: string[],
  languageCode: string = 'en'
): Promise<string[]> {
  const exists = await fileExists(filePath);
  if (!exists) {
    return [];
  }

  const fileExt = path.extname(filePath).slice(1).toLowerCase();
  return fileExt === 'json'
    ? deleteKeysFromJsonFile(filePath, keysToDelete, languageCode)
    : deleteKeysFromYamlFile(filePath, keysToDelete, languageCode);
}