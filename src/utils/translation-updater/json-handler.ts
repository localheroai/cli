import { promises as fs } from 'fs';
import { detectJsonFormat, preserveJsonStructure } from '../files.js';
import { ensureDirectoryExists } from './common.js';

interface UpdateResult {
  updatedKeys: string[];
  created: boolean;
}

type JsonFormat = 'nested' | 'flat' | 'mixed';

async function detectSourceFileStructure(sourceFilePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(sourceFilePath, 'utf8');
    const sourceContent = JSON.parse(content);
    const hasLanguageWrapper = Object.entries(sourceContent).some(([key, value]) => {
      // Check if any top-level key is a language code with an object value
      return typeof value === 'object' && value !== null && /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(key);
    });

    return hasLanguageWrapper;
  } catch (error) {
    throw new Error(`Failed to read source file ${sourceFilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateJsonFile(
  filePath: string,
  translations: Record<string, unknown>,
  languageCode: string,
  sourceFilePath: string | null = null
): Promise<UpdateResult> {
  try {
    let existingContent: Record<string, any> = {};
    let jsonFormat: JsonFormat = 'nested';
    let hasLanguageWrapper = false;
    const result: UpdateResult = {
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
      if (!sourceFilePath) {
        throw new Error('Source file is required for creating new JSON translation files');
      }

      console.warn(`Creating new JSON file: ${filePath}`);
      result.created = true;
      await ensureDirectoryExists(filePath);

      // Use source file structure
      hasLanguageWrapper = await detectSourceFileStructure(sourceFilePath);
    }

    let updatedContent: Record<string, any>;

    if (result.created) {
      updatedContent = hasLanguageWrapper ?
        { [languageCode]: preserveJsonStructure({}, translations, jsonFormat) } :
        preserveJsonStructure({}, translations, jsonFormat);
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
    throw new Error(`Failed to update JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function deleteKeysFromJsonFile(
  filePath: string,
  keysToDelete: string[],
  languageCode: string
): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    let jsonContent: Record<string, any> = JSON.parse(content);
    let hasLanguageWrapper = false;
    let rootContent = jsonContent;
    if (jsonContent[languageCode] && typeof jsonContent[languageCode] === 'object') {
      hasLanguageWrapper = true;
      rootContent = jsonContent[languageCode];
    }

    const deletedKeys: string[] = [];

    for (const keyPath of keysToDelete) {
      const keys = keyPath.split('.');
      const lastIndex = keys.length - 1;
      let current = rootContent;
      let parent: Record<string, any> | null = null;
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
    throw new Error(`Failed to delete keys from JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}