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
  let inMultiline = false;
  let multilinePath = '';
  let multilineIndent = 0;

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
    const match = line.trim().match(keyValueRegex);

    if (match) {
      const key = match[1].trim();
      const value = match[2];

      currentPath[level] = key;
      const fullPath = currentPath.slice(0, pathLength + 1).join('.');

      // Detect multiline string start
      if (value?.trim() === '|') {
        inMultiline = true;
        multilinePath = fullPath;
        multilineIndent = indent + 2;
        styles.set(fullPath, {
          multiline: true,
          indicator: '|',
          indentation: indent
        });
        continue;
      }

      if (value) {
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
    }
  }

  return styles;
}

const SPECIAL_CHARS_REGEX = /[:@#,[\]{}?|>&*!\n]/;
const INTERPOLATION = '%{';
const INDENT_CACHE = new Map();

function getIndent(level) {
  let indent = INDENT_CACHE.get(level);
  if (!indent) {
    indent = ' '.repeat(level);
    INDENT_CACHE.set(level, indent);
  }
  return indent;
}

function stringifyYaml(obj, indent = 0, parentPath = '', result = [], styles) {
  const indentStr = getIndent(indent);

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;
    const style = styles.get(currentPath);

    if (value && typeof value === 'object') {
      result.push(`${indentStr}${key}:`);
      stringifyYaml(value, indent + 2, currentPath, result, styles);
    } else {
      if (typeof value === 'string' && (style?.multiline || value.includes('\n'))) {
        result.push(`${indentStr}${key}: |`);
        const lines = value.split('\n');
        for (const line of lines) {
          result.push(`${indentStr}  ${line}`);
        }
      } else {
        let formattedValue = value;

        if (typeof value === 'string') {
          const existingStyle = styles.get(currentPath);

          if (existingStyle?.quoted) {
            formattedValue = `${existingStyle.quoteType}${value}${existingStyle.quoteType}`;
          } else if (existingStyle?.originalValue === value) {
            formattedValue = existingStyle.originalValue;
          } else if (value.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(value)) {
            formattedValue = `"${value}"`;
          }
        }

        result.push(`${indentStr}${key}: ${formattedValue}`);
      }
    }
  }

  return result;
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
    let styles;
    try {
      existingContent = await fs.readFile(filePath, 'utf8');
      styles = getExistingQuoteStyles(existingContent);
    } catch {
      console.warn(`Creating new file: ${filePath}`);
      styles = new Map();
      result.created = true;
    }

    const hasTrailingSpace = /\s$/.test(existingContent);
    const yamlContent = yaml.parse(existingContent) || {};
    const sourceLanguage = Object.keys(yamlContent)[0];

    if (sourceLanguage && sourceLanguage !== languageCode && yamlContent[sourceLanguage]) {
      return result;
    }

    yamlContent[languageCode] = yamlContent[languageCode] || {};

    for (const [keyPath, newValue] of Object.entries(translations)) {
      const keys = keyPath.split('.');
      let current = yamlContent[languageCode];
      const lastIndex = keys.length - 1;

      for (let i = 0; i < lastIndex; i++) {
        const key = keys[i];
        current[key] = current[key] || {};
        current = current[key];
      }

      current[keys[lastIndex]] = newValue;
    }

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const content = stringifyYaml(yamlContent, 0, '', [], styles);
    const finalContent = content.join('\n') + (hasTrailingSpace ? '\n' : '');

    await fs.writeFile(filePath, finalContent);
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
    const styles = getExistingQuoteStyles(content);
    const hasTrailingSpace = /\s$/.test(content);

    const yamlContent = yaml.parse(content) || {};
    if (!yamlContent[languageCode]) {
      return [];
    }

    const deletedKeys = [];

    for (const keyPath of keysToDelete) {
      const keys = keyPath.split('.');
      const lastIndex = keys.length - 1;
      let current = yamlContent[languageCode];
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
    const yamlLines = stringifyYaml(yamlContent, 0, '', [], styles);
    const finalContent = yamlLines.join('\n') + (hasTrailingSpace ? '\n' : '');

    await fs.writeFile(filePath, finalContent);

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

    if (hasLanguageWrapper) {
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
      updatedContent = {
        [languageCode]: preserveJsonStructure(existingCopy, translations, jsonFormat)
      };
    }
    await fs.writeFile(filePath, JSON.stringify(updatedContent, null, 2));

    return result;
  } catch (error) {
    throw new Error(`Failed to update JSON file ${filePath}: ${error.message}`);
  }
}