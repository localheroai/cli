import { promises as fs } from 'fs';
import yaml from 'yaml';
import { SPECIAL_CHARS_REGEX, INTERPOLATION, fileExists, tryParseJsonArray } from './common.js';

const NEEDS_QUOTES_REGEX = /[:,%{}[\]|><!&*?-]/;
const LINE_WIDTH = 80;

function detectYamlOptions(content) {
  const lines = content
    .split('\n')
    .filter(line => line.trim())
    .slice(0, 10);

  const options = {
    indent: 2,
    indentSeq: true
  };

  const indentMatch = lines.find(line => /^\s+\S/.test(line))?.match(/^(\s+)\S/);
  if (indentMatch) {
    options.indent = indentMatch[1].length;
    if (indentMatch[1].includes('\t')) {
      options.indent = 2;
    }
  }

  const seqMatch = lines.find(line => /^\s*-\s+\S/.test(line));
  if (seqMatch) {
    options.indentSeq = /^\s+-\s+/.test(seqMatch);
  }

  return options;
}

function needsQuotes(str) {
  if (typeof str !== 'string') return false;

  return (
    SPECIAL_CHARS_REGEX.test(str) ||
    str.includes(INTERPOLATION) ||
    NEEDS_QUOTES_REGEX.test(str) ||
    (str.includes(' ') && /[:"']/g.test(str))
  );
}

function shouldForceQuotes(str) {
  if (typeof str !== 'string') return false;

  // Special case: strings containing quotes but no interpolation
  // don't need outer quotes
  if (str.includes('"') && !str.includes(INTERPOLATION)) {
    return false;
  }

  return needsQuotes(str);
}

function processArrayItems(array, yamlDoc) {
  return array.map(item => {
    const itemNode = yamlDoc.createNode(item);
    if (shouldForceQuotes(item)) {
      itemNode.type = 'QUOTE_DOUBLE';
    }
    return itemNode;
  });
}

async function createYamlDocument(filePath) {
  const exists = await fileExists(filePath);
  if (!exists) {
    console.warn(`Creating new file: ${filePath}`);
    const doc = new yaml.Document();
    doc.contents = doc.createNode({});
    return { doc, created: true, options: { indent: 2, indentSeq: true, lineWidth: LINE_WIDTH } };
  }

  const content = await fs.readFile(filePath, 'utf8');
  const options = detectYamlOptions(content);
  const doc = yaml.parseDocument(content);
  doc.options.lineWidth = LINE_WIDTH;
  return {
    doc,
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

    if (Array.isArray(newValue)) {
      const arrayNode = new yaml.YAMLSeq();
      processArrayItems(newValue, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    const array = tryParseJsonArray(newValue);
    if (array) {
      const arrayNode = new yaml.YAMLSeq();
      processArrayItems(array, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    if (typeof newValue === 'string' && newValue.includes('\n')) {
      const scalar = new yaml.Scalar(newValue);
      scalar.type = 'BLOCK_LITERAL';
      current.set(lastKey, scalar);
      continue;
    }

    const node = yamlDoc.createNode(newValue);
    if (needsQuotes(newValue)) {
      node.type = 'QUOTE_DOUBLE';
    }
    current.set(lastKey, node);
  }
}

export async function updateYamlFile(filePath, translations, languageCode) {
  const { doc: yamlDoc, created, options } = await createYamlDocument(filePath);

  await updateYamlTranslations(yamlDoc, translations, languageCode);

  yamlDoc.options.indent = options.indent;
  yamlDoc.options.indentSeq = options.indentSeq;
  yamlDoc.options.lineWidth = LINE_WIDTH;

  await fs.writeFile(filePath, yamlDoc.toString());
  return {
    updatedKeys: Object.keys(translations),
    created
  };
}

export async function deleteKeysFromYamlFile(filePath, keysToDelete, languageCode) {
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