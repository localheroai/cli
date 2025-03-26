import path from 'path';
import { fileExists, ensureDirectoryExists } from './common.js';
import { updateYamlFile, deleteKeysFromYamlFile } from './yaml-handler.js';
import { updateJsonFile, deleteKeysFromJsonFile } from './json-handler.js';

export async function updateTranslationFile(filePath, translations, languageCode = 'en') {
    const fileExt = path.extname(filePath).slice(1).toLowerCase();
    const result = {
        updatedKeys: Object.keys(translations),
        created: false
    };

    await ensureDirectoryExists(filePath);

    if (fileExt === 'json') {
        const jsonResult = await updateJsonFile(filePath, translations, languageCode);
        return {
            updatedKeys: result.updatedKeys,
            created: jsonResult.created
        };
    }

    return updateYamlFile(filePath, translations, languageCode);
}

export async function deleteKeysFromTranslationFile(filePath, keysToDelete, languageCode = 'en') {
    const exists = await fileExists(filePath);
    if (!exists) {
        return [];
    }

    const fileExt = path.extname(filePath).slice(1).toLowerCase();
    return fileExt === 'json'
        ? deleteKeysFromJsonFile(filePath, keysToDelete, languageCode)
        : deleteKeysFromYamlFile(filePath, keysToDelete, languageCode);
}