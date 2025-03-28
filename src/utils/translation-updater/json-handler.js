import { promises as fs } from 'fs';
import { detectJsonFormat, preserveJsonStructure } from '../files.js';
import { ensureDirectoryExists } from './common.js';

export async function updateJsonFile(filePath, translations, languageCode) {
  try {
    let existingContent = {};
    let jsonFormat = 'nested';
    let hasLanguageWrapper = false;
    const result = {
      updatedKeys: Object.keys(translations),
      created: false
    };

    try {
      const content = await fs.readFile(filePath, 'utf8');
      existingContent = JSON.parse(content);
      if (existingContent[languageCode] && typeof existingContent[languageCode] === 'object') {
        hasLanguageWrapper = true;
        jsonFormat = detectJsonFormat(existingContent[languageCode]);
      } else {
        jsonFormat = detectJsonFormat(existingContent);
      }
    } catch {
      console.warn(`Creating new JSON file: ${filePath}`);
      result.created = true;
      await ensureDirectoryExists(filePath);
    }

    let updatedContent;

    if (result.created) {
      updatedContent = {
        [languageCode]: preserveJsonStructure({}, translations, jsonFormat)
      };
    } else if (hasLanguageWrapper) {
      existingContent[languageCode] = existingContent[languageCode] || {};
      updatedContent = JSON.parse(JSON.stringify(existingContent));
      const mergedContent = preserveJsonStructure(
        existingContent[languageCode],
        translations,
        jsonFormat
      );
      updatedContent[languageCode] = mergedContent;
    } else {
      const existingCopy = JSON.parse(JSON.stringify(existingContent));
      updatedContent = preserveJsonStructure(existingCopy, translations, jsonFormat);
    }

    await fs.writeFile(filePath, JSON.stringify(updatedContent, null, 2));
    return result;
  } catch (error) {
    throw new Error(`Failed to update JSON file ${filePath}: ${error.message}`);
  }
}

export async function deleteKeysFromJsonFile(filePath, keysToDelete, languageCode) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    let jsonContent = JSON.parse(content);
    let hasLanguageWrapper = false;
    let rootContent = jsonContent;
    if (jsonContent[languageCode] && typeof jsonContent[languageCode] === 'object') {
      hasLanguageWrapper = true;
      rootContent = jsonContent[languageCode];
    }

    const deletedKeys = [];

    for (const keyPath of keysToDelete) {
      const keys = keyPath.split('.');
      const lastIndex = keys.length - 1;
      let current = rootContent;
      let parent = null;
      let keyInParent = '';
      let found = true;

      for (let i = 0; i < lastIndex; i++) {
        const key = keys[i];
        if (!current[key] || typeof current[key] !== 'object') {
          found = false;
          break;
        }
        parent = current;
        keyInParent = key;
        current = current[key];
      }

      if (found) {
        const lastKey = keys[lastIndex];
        if (current[lastKey] !== undefined) {
          delete current[lastKey];
          deletedKeys.push(keyPath);
          if (parent && Object.keys(current).length === 0) {
            delete parent[keyInParent];
          }
        }
      }
    }
    if (hasLanguageWrapper) {
      jsonContent[languageCode] = rootContent;
    } else {
      jsonContent = rootContent;
    }
    await fs.writeFile(filePath, JSON.stringify(jsonContent, null, 2));

    return deletedKeys;
  } catch (error) {
    throw new Error(`Failed to delete keys from JSON file ${filePath}: ${error.message}`);
  }
}