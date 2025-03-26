import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'yaml';
import { detectJsonFormat, preserveJsonStructure } from './files.js';

function getExistingQuoteStyles(content) {
  const styles = new Map();
  const lines = content.match(/[^\n]+/g) || [];
  const currentPath = new Array(10);
  let pathLength = 0;
  const indentRegex = /^\s*/;
  const keyValueRegex = /^([^:]+):\s*(.*)$/;
  const doubleQuoteRegex = /^"(.*)"$/;
  const singleQuoteRegex = /^'(.*)'$/;
  const arrayItemRegex = /^\s*-\s+(.+)$/;
  let inMultiline = false;
  let multilineIndent = 0;
  let currentArrayPath = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().startsWith('#')) continue;

    const indent = line.match(indentRegex)[0].length;
    const level = indent >> 1; /* Divide by 2 using bit shift */

    if (inMultiline) {
      if (indent < multilineIndent) {
        inMultiline = false;
      } else {
        continue;
      }
    }

    pathLength = level;
    const arrayMatch = line.trim().match(arrayItemRegex);

    if (arrayMatch && currentArrayPath) {
      const value = arrayMatch[1];
      const quoteType = doubleQuoteRegex.test(value) ? '"' : (singleQuoteRegex.test(value) ? "'" : '');

      const arrayStyles = styles.get(currentArrayPath) || { arrayItems: [] };
      arrayStyles.arrayItems = arrayStyles.arrayItems || [];
      arrayStyles.arrayItems.push({ quoted: Boolean(quoteType), quoteType });
      styles.set(currentArrayPath, arrayStyles);
      continue;
    }

    const match = line.trim().match(keyValueRegex);

    if (match) {
      const key = match[1].trim();
      const value = match[2];

      currentPath[level] = key;
      const fullPath = currentPath.slice(0, pathLength + 1).join('.');

      // Track if this is the start of an array
      if (value === '') {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.trim().startsWith('-')) {
          currentArrayPath = fullPath;
          styles.set(fullPath, { isArray: true, arrayItems: [] });
          continue;
        }
      }

      // Detect multiline string start
      if (value?.trim() === '|') {
        inMultiline = true;
        multilineIndent = indent + 2;
        styles.set(fullPath, {
          multiline: true,
          indicator: '|',
          indentation: indent
        });
        continue;
      }

      if (value) {
        currentArrayPath = '';
        const valueTrimed = value.trim();
        const hasDoubleQuotes = doubleQuoteRegex.test(valueTrimed);
        const hasSingleQuotes = !hasDoubleQuotes && singleQuoteRegex.test(valueTrimed);

        if (hasDoubleQuotes || hasSingleQuotes || valueTrimed) {
          styles.set(fullPath, {
            quoted: hasDoubleQuotes || hasSingleQuotes,
            quoteType: hasDoubleQuotes ? '"' : (hasSingleQuotes ? "'" : ''),
            originalValue: valueTrimed
          });
        }
      }
    } else {
      currentArrayPath = '';
    }
  }

  return styles;
}

const SPECIAL_CHARS_REGEX = /[:@#,[\]{}?|>&*!\n]/;
const INTERPOLATION = '%{';
const INDENT_CACHE = new Map();
const MAX_ARRAY_LENGTH = 1000; // Reasonable limit for translation arrays

function getIndent(level) {
  let indent = INDENT_CACHE.get(level);
  if (!indent) {
    indent = ' '.repeat(level);
    INDENT_CACHE.set(level, indent);
  }
  return indent;
}

function formatArrayItems(array, indentStr, styles, currentPath) {
  const style = styles.get(currentPath);
  const arrayStyles = style?.arrayItems || [];

  return array.map((item, index) => {
    const stringValue = String(item);
    const itemStyle = arrayStyles[index];

    // If we have a stored style for this item, use it
    if (itemStyle) {
      const escapedValue = itemStyle.quoteType === '"' && stringValue.includes('"')
        ? stringValue.replace(/"/g, '\\"')
        : stringValue;
      return `${indentStr}  - ${itemStyle.quoted ? `${itemStyle.quoteType}${escapedValue}${itemStyle.quoteType}` : escapedValue}`;
    }

    // Fall back to the original logic for new items
    const needsQuotes = typeof item === 'string' &&
      (item.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(item));
    const escapedValue = needsQuotes && stringValue.includes('"')
      ? stringValue.replace(/"/g, '\\"')
      : stringValue;

    return `${indentStr}  - ${needsQuotes ? `"${escapedValue}"` : escapedValue}`;
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

    // We don't want extremely large arrays
    if (parsed.length > MAX_ARRAY_LENGTH) {
      console.warn(`Array length ${parsed.length} exceeds maximum allowed length of ${MAX_ARRAY_LENGTH}`);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function stringifyYaml(obj, indent = 0, parentPath = '', result = [], styles) {
  const indentStr = getIndent(indent);

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;
    const style = styles.get(currentPath);

    // Handle arrays
    let array = null;
    if (Array.isArray(value)) {
      array = value;
    } else if (typeof value === 'string') {
      array = tryParseJsonArray(value);
    }

    if (array) {
      if (array.length > MAX_ARRAY_LENGTH) {
        console.warn(`Skipping array for key ${key}: length exceeds maximum`);
        result.push(`${indentStr}${key}: []`);
        continue;
      }
      result.push(`${indentStr}${key}:`);
      result.push(...formatArrayItems(array, indentStr, styles, currentPath));
      continue;
    }

    // Handle nested objects
    if (value && typeof value === 'object') {
      result.push(`${indentStr}${key}:`);
      stringifyYaml(value, indent + 2, currentPath, result, styles);
      continue;
    }

    // Handle multiline strings
    if (typeof value === 'string' && (style?.multiline || value.includes('\n'))) {
      result.push(`${indentStr}${key}: |`);
      const lines = value.split('\n');
      for (const line of lines) {
        result.push(line.length > 0 ? `${indentStr}  ${line}` : '');
      }
      continue;
    }

    // Handle regular strings
    if (typeof value === 'string') {
      const existingStyle = styles.get(currentPath);
      if (existingStyle?.quoted) {
        result.push(`${indentStr}${key}: ${existingStyle.quoteType}${value}${existingStyle.quoteType}`);
      } else if (value.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(value)) {
        result.push(`${indentStr}${key}: "${value}"`);
      } else {
        result.push(`${indentStr}${key}: ${value}`);
      }
      continue;
    }

    // Handle all other values
    result.push(`${indentStr}${key}: ${value}`);
  }

  return result;
}

// Utility to process array items with proper quoting
function processArrayItems(array, yamlDoc) {
  return array.map(item => {
    const itemNode = yamlDoc.createNode(item);

    // Add quotes for items that need them
    if (typeof item === 'string') {
      const needsQuotes = item.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(item);
      if (needsQuotes) {
        itemNode.type = 'QUOTE_DOUBLE';
      }
    }
    return itemNode;
  });
}

export async function updateTranslationFile(filePath, translations, languageCode = 'en') {
  try {
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

    let existingContent = '';
    let yamlDoc;

    try {
      existingContent = await fs.readFile(filePath, 'utf8');
      yamlDoc = yaml.parseDocument(existingContent);
    } catch (error) {
      console.warn(`Creating new file: ${filePath}`);
      result.created = true;
      yamlDoc = new yaml.Document();
      yamlDoc.contents = yamlDoc.createNode({});
    }

    // Get the root node, create language node if needed
    if (!yamlDoc.contents) {
      yamlDoc.contents = yamlDoc.createNode({});
    }

    let rootNode = yamlDoc.contents;
    if (!rootNode.has(languageCode)) {
      rootNode.set(languageCode, yamlDoc.createNode({}));
    }

    let langNode = rootNode.get(languageCode);

    // Update each translation key
    for (const [keyPath, newValue] of Object.entries(translations)) {
      const keys = keyPath.split('.');
      let current = langNode;

      // Navigate to the parent node, creating intermediate nodes as needed
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!current.has(key)) {
          current.set(key, yamlDoc.createNode({}));
        }
        current = current.get(key);
      }

      // Set the final value
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

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Configure the document options for consistent formatting
    yamlDoc.options.indent = 2;
    yamlDoc.options.indentSeq = true;

    // Use Document.toString() to preserve comments and structure
    await fs.writeFile(filePath, yamlDoc.toString());
    return result;

  } catch (error) {
    throw new Error(`Failed to update translation file ${filePath}: ${error.message}`);
  }
}

export async function deleteKeysFromTranslationFile(filePath, keysToDelete, languageCode = 'en') {
  try {
    const fileExt = path.extname(filePath).slice(1).toLowerCase();
    try {
      await fs.access(filePath);
    } catch {
      return [];
    }

    if (fileExt === 'json') {
      return await deleteKeysFromJsonFile(filePath, keysToDelete, languageCode);
    } else {
      return await deleteKeysFromYamlFile(filePath, keysToDelete, languageCode);
    }
  } catch (error) {
    throw new Error(`Failed to delete keys from file ${filePath}: ${error.message}`);
  }
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