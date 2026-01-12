import { promises as fs } from 'fs';
import { detectJsonFormat, preserveJsonStructure } from '../files.js';
import { ensureDirectoryExists } from './common.js';

interface UpdateResult {
  updatedKeys: string[];
  created: boolean;
}

type JsonFormat = 'nested' | 'flat' | 'mixed';

interface FileStructure {
  hasLanguageWrapper: boolean;
  jsonFormat: JsonFormat;
}

function detectStructureFromContent(
  content: Record<string, unknown>,
  languageCode: string
): FileStructure | null {
  const languageValue = content[languageCode];
  const hasLanguageWrapper = languageValue !== undefined &&
    typeof languageValue === 'object' &&
    languageValue !== null;

  if (hasLanguageWrapper) {
    const innerContent = languageValue as Record<string, unknown>;
    if (Object.keys(innerContent).length === 0) {
      return null;
    }
    return { hasLanguageWrapper: true, jsonFormat: detectJsonFormat(innerContent) };
  }

  if (Object.keys(content).length === 0) {
    return null;
  }
  return { hasLanguageWrapper: false, jsonFormat: detectJsonFormat(content) };
}

async function readSourceFileStructure(sourceFilePath: string): Promise<FileStructure> {
  const content = await fs.readFile(sourceFilePath, 'utf8');
  const sourceContent = JSON.parse(content);

  for (const [key, value] of Object.entries(sourceContent)) {
    if (typeof value === 'object' && value !== null && /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(key)) {
      return {
        hasLanguageWrapper: true,
        jsonFormat: detectJsonFormat(value as Record<string, unknown>)
      };
    }
  }

  return { hasLanguageWrapper: false, jsonFormat: detectJsonFormat(sourceContent) };
}

async function getStructure(
  existingContent: Record<string, unknown> | null,
  languageCode: string,
  sourceFilePath: string | null
): Promise<FileStructure> {
  if (existingContent) {
    const detected = detectStructureFromContent(existingContent, languageCode);
    if (detected) {
      return detected;
    }
  }

  if (!sourceFilePath) {
    throw new Error('Source file is required for creating new JSON translation files');
  }

  return readSourceFileStructure(sourceFilePath);
}

export async function updateJsonFile(
  filePath: string,
  translations: Record<string, unknown>,
  languageCode: string,
  sourceFilePath: string | null = null
): Promise<UpdateResult> {
  let existingContent: Record<string, any> | null = null;
  let created = false;

  try {
    const content = await fs.readFile(filePath, 'utf8');
    existingContent = JSON.parse(content);
  } catch {
    console.warn(`Creating new JSON file: ${filePath}`);
    created = true;
    await ensureDirectoryExists(filePath);
  }

  const { hasLanguageWrapper, jsonFormat } = await getStructure(
    existingContent,
    languageCode,
    sourceFilePath
  );

  const baseContent = hasLanguageWrapper
    ? (existingContent?.[languageCode] ?? {})
    : (existingContent ?? {});

  const mergedContent = preserveJsonStructure(
    JSON.parse(JSON.stringify(baseContent)),
    translations,
    jsonFormat
  );

  const updatedContent = hasLanguageWrapper
    ? { ...existingContent, [languageCode]: mergedContent }
    : mergedContent;

  await fs.writeFile(filePath, JSON.stringify(updatedContent, null, 2));

  return {
    updatedKeys: Object.keys(translations),
    created
  };
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