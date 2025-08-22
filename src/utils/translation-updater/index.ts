import path from 'path';
import { fileExists, ensureDirectoryExists } from './common.js';
import { updateYamlFile, deleteKeysFromYamlFile } from './yaml-handler.js';
import { updateJsonFile, deleteKeysFromJsonFile } from './json-handler.js';
import { updatePoFile, deleteKeysFromPoFile } from './po-handler.js';

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

  // Filter out any null values
  const filteredTranslations = Object.fromEntries(
    Object.entries(translations).filter(([_, value]) => value !== null)
  );

  if (fileExt === 'json') {
    const jsonResult = await updateJsonFile(filePath, filteredTranslations, languageCode, sourceFilePath);
    return {
      updatedKeys: result.updatedKeys,
      created: jsonResult.created
    };
  }

  if (fileExt === 'po') {
    const poResult = await updatePoFile(filePath, filteredTranslations, languageCode, sourceFilePath);
    return {
      updatedKeys: result.updatedKeys,
      created: poResult.created
    };
  }

  return updateYamlFile(filePath, filteredTranslations, languageCode);
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
  
  if (fileExt === 'json') {
    return deleteKeysFromJsonFile(filePath, keysToDelete, languageCode);
  }
  
  if (fileExt === 'po') {
    await deleteKeysFromPoFile(filePath, keysToDelete);
    return keysToDelete; // Po handler doesn't return which were actually deleted
  }
  
  return deleteKeysFromYamlFile(filePath, keysToDelete, languageCode);
}