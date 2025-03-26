import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'yaml';
import { detectJsonFormat, preserveJsonStructure } from './files.js';

const SPECIAL_CHARS_REGEX = /[:@#,[\]{}?|>&*!\n]/;
const INTERPOLATION = '%{';
const MAX_ARRAY_LENGTH = 1000; // Reasonable limit for translation arrays

function detectYamlOptions(content) {
  // Only look at first 10 non-empty lines
  const lines = content
    .split('\n')
    .filter(line => line.trim())
    .slice(0, 10);

  const options = {
    indent: 2,
    indentSeq: true
  };

  // Find first indented line to detect indent size
  const indentMatch = lines.find(line => /^\s+\S/.test(line))?.match(/^(\s+)\S/);
  if (indentMatch) {
    options.indent = indentMatch[1].length;
    if (indentMatch[1].includes('\t')) {
      options.indent = 2;
    }
  }

  // Check if sequences are indented
  const seqMatch = lines.find(line => /^\s*-\s+\S/.test(line));
  if (seqMatch) {
    options.indentSeq = /^\s+-\s+/.test(seqMatch);
  }

  return options;
}

function processArrayItems(array, yamlDoc) {
  return array.map(item => {
    const itemNode = yamlDoc.createNode(item);
    if (typeof item === 'string') {
      const needsQuotes = item.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(item);
      if (needsQuotes) {
        itemNode.type = 'QUOTE_DOUBLE';
      }
    }
    return itemNode;
  });
}

function tryParseJsonArray(value) {
  if (typeof value !== 'string' || !value.startsWith('["') || !value.endsWith('"]')) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }

    if (parsed.length > MAX_ARRAY_LENGTH) {
      console.warn(`Array length ${parsed.length} exceeds maximum allowed length of ${MAX_ARRAY_LENGTH}`);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (dir !== '.') {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function createYamlDocument(filePath) {
  const exists = await fileExists(filePath);
  if (!exists) {
    console.warn(`Creating new file: ${filePath}`);
    const doc = new yaml.Document();
    doc.contents = doc.createNode({});
    return { doc, created: true, options: { indent: 2, indentSeq: true } };
  }

  const content = await fs.readFile(filePath, 'utf8');
  const options = detectYamlOptions(content);
  return {
    doc: yaml.parseDocument(content),
    created: false,
    options
  };
}

async function updateYamlTranslations(yamlDoc, translations, languageCode) {
  if (!yamlDoc.contents) {
    yamlDoc.contents = yamlDoc.createNode({});
  }

  const rootNode = yamlDoc.contents;
  if (!rootNode.has(languageCode)) {
    rootNode.set(languageCode, yamlDoc.createNode({}));
  }

  const langNode = rootNode.get(languageCode);

  for (const [keyPath, newValue] of Object.entries(translations)) {
    const keys = keyPath.split('.');
    let current = langNode;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current.has(key)) {
        current.set(key, yamlDoc.createNode({}));
      }
      current = current.get(key);
    }

    const lastKey = keys[keys.length - 1];

    // Handle arrays
    if (Array.isArray(newValue)) {
      const arrayNode = new yaml.YAMLSeq();
      processArrayItems(newValue, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    // Handle potential JSON array strings
    const array = tryParseJsonArray(newValue);
    if (array) {
      const arrayNode = new yaml.YAMLSeq();
      processArrayItems(array, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    // Handle multiline strings
    if (typeof newValue === 'string' && newValue.includes('\n')) {
      const scalar = new yaml.Scalar(newValue);
      scalar.type = 'BLOCK_LITERAL';
      current.set(lastKey, scalar);
      continue;
    }

    // Handle regular values
    const node = yamlDoc.createNode(newValue);
    if (typeof newValue === 'string' && (newValue.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(newValue))) {
      node.type = 'QUOTE_DOUBLE';
    }
    current.set(lastKey, node);
  }
}

export async function updateTranslationFile(filePath, translations, languageCode = 'en') {
  const fileExt = path.extname(filePath).slice(1).toLowerCase();
  const result = {
    updatedKeys: Object.keys(translations),
    created: false
  };

  if (fileExt === 'json') {
    const jsonResult = await updateJsonFile(filePath, translations, languageCode);
    return {
      updatedKeys: result.updatedKeys,
      created: jsonResult.created
    };
  }

  await ensureDirectoryExists(filePath);
  const { doc: yamlDoc, created, options } = await createYamlDocument(filePath);
  result.created = created;

  await updateYamlTranslations(yamlDoc, translations, languageCode);

  yamlDoc.options.indent = options.indent;
  yamlDoc.options.indentSeq = options.indentSeq;

  await fs.writeFile(filePath, yamlDoc.toString());
  return result;
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

async function deleteKeysFromJsonFile(filePath, keysToDelete, languageCode) {
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

async function deleteKeysFromYamlFile(filePath, keysToDelete, languageCode) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const yamlDoc = yaml.parseDocument(content);
    if (!yamlDoc.contents || !yamlDoc.contents.has(languageCode)) {
      return [];
    }

    const langNode = yamlDoc.contents.get(languageCode);
    const deletedKeys = [];

    for (const keyPath of keysToDelete) {
      const keys = keyPath.split('.');
      const lastIndex = keys.length - 1;
      let current = langNode;
      let parent = null;
      let keyInParent = '';
      let found = true;

      for (let i = 0; i < lastIndex; i++) {
        const key = keys[i];
        if (!current.has(key)) {
          found = false;
          break;
        }
        parent = current;
        keyInParent = key;
        current = current.get(key);
      }

      if (found) {
        const lastKey = keys[lastIndex];
        if (current.has(lastKey)) {
          current.delete(lastKey);
          deletedKeys.push(keyPath);
          if (parent && current.items.length === 0) {
            parent.delete(keyInParent);
          }
        }
      }
    }

    await fs.writeFile(filePath, yamlDoc.toString());
    return deletedKeys;
  } catch (error) {
    throw new Error(`Failed to delete keys from YAML file ${filePath}: ${error.message}`);
  }
}

async function updateJsonFile(filePath, translations, languageCode) {
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
      const dir = path.dirname(filePath);
      if (dir !== '.') {
        await fs.mkdir(dir, { recursive: true });
      }
    }

    let updatedContent;

    if (result.created) {
      // For new files, use language wrapper by default
      updatedContent = {
        [languageCode]: preserveJsonStructure({}, translations, jsonFormat)
      };
    } else if (hasLanguageWrapper) {
      // For existing files with language wrapper, preserve it
      existingContent[languageCode] = existingContent[languageCode] || {};
      updatedContent = JSON.parse(JSON.stringify(existingContent));
      const mergedContent = preserveJsonStructure(
        existingContent[languageCode],
        translations,
        jsonFormat
      );
      updatedContent[languageCode] = mergedContent;
    } else {
      // For existing files without language wrapper, preserve flat structure
      const existingCopy = JSON.parse(JSON.stringify(existingContent));
      updatedContent = preserveJsonStructure(existingCopy, translations, jsonFormat);
    }

    await fs.writeFile(filePath, JSON.stringify(updatedContent, null, 2));
    return result;
  } catch (error) {
    throw new Error(`Failed to update JSON file ${filePath}: ${error.message}`);
  }
}