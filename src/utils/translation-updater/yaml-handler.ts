import { promises as fs } from 'fs';
import yaml from 'yaml';
import { SPECIAL_CHARS_REGEX, INTERPOLATION, CLDR_PLURAL_CATEGORIES, fileExists, tryParseJsonArray } from './common.js';
import {
  spliceYamlUpdate,
  spliceYamlDelete,
  hasUnsupportedValueShape
} from './yaml-splicer.js';

interface YamlOptions {
  indent: number;
  indentSeq: boolean;
  lineWidth?: number;
}

type YamlMap = yaml.YAMLMap;
type YamlNode = yaml.Node | yaml.YAMLMap | yaml.YAMLSeq | yaml.Scalar;
type YamlScalar = yaml.Scalar;
type YamlSeq = yaml.YAMLSeq;

interface YamlDocumentResult {
  doc: yaml.Document;
  created: boolean;
  options: YamlOptions;
}

interface UpdateResult {
  updatedKeys: string[];
  created: boolean;
}

const NEEDS_QUOTES_REGEX = /[:,%{}[\]|><!&*?-]/;
const LINE_WIDTH = 0;

function detectYamlOptions(content: string): YamlOptions {
  const lines = content
    .split('\n')
    .filter(line => line.trim())
    .slice(0, 10);

  const options: YamlOptions = {
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

function isQuotedType(type: string | null | undefined): boolean {
  return type === 'QUOTE_DOUBLE' || type === 'QUOTE_SINGLE';
}

function needsQuotes(str: unknown): boolean {
  if (typeof str !== 'string') return false;

  return (
    SPECIAL_CHARS_REGEX.test(str) ||
    str.includes(INTERPOLATION) ||
    NEEDS_QUOTES_REGEX.test(str) ||
    (str.includes(' ') && /[:"']/g.test(str))
  );
}

function shouldForceQuotes(str: unknown): boolean {
  if (typeof str !== 'string') return false;

  if (str.includes('"') && !str.includes(INTERPOLATION)) {
    return false;
  }

  return needsQuotes(str);
}

// A node worth preserving as `.other` when a flat value is migrated into a
// plural map: a scalar with a real value, or a non-empty sequence. Blank
// scalars and empty sequences carry nothing to keep.
function hasPreservableNode(node: unknown): boolean {
  if (yaml.isScalar(node)) {
    const value = node.value;
    return value !== undefined && value !== null && value !== '';
  }
  if (yaml.isSeq(node)) {
    return node.items.length > 0;
  }
  return false;
}

function processArrayItems(array: unknown[], yamlDoc: yaml.Document): YamlNode[] {
  return array.map(item => {
    const itemNode = yamlDoc.createNode(item) as YamlNode;
    if (shouldForceQuotes(item)) {
      (itemNode as YamlScalar).type = 'QUOTE_DOUBLE';
    }
    return itemNode;
  });
}

async function createYamlDocument(filePath: string): Promise<YamlDocumentResult> {
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
  clearDuplicateKeyErrors(doc, filePath);
  return {
    doc,
    created: false,
    options
  };
}

function clearDuplicateKeyErrors(doc: yaml.Document, filePath: string): void {
  if (doc.errors.length === 0) return;

  const duplicateKeyErrors = doc.errors.filter(e => e.code === 'DUPLICATE_KEY');
  if (duplicateKeyErrors.length === 0) return;

  console.warn(`Warning: ${filePath} has ${duplicateKeyErrors.length} duplicate key(s), using last value for each`);
  doc.errors = doc.errors.filter(e => e.code !== 'DUPLICATE_KEY');
}

async function updateYamlTranslations(
  yamlDoc: yaml.Document,
  translations: Record<string, unknown>,
  languageCode: string
): Promise<void> {
  if (!yamlDoc.contents) {
    yamlDoc.contents = yamlDoc.createNode({});
  }

  const rootNode = yamlDoc.contents as YamlMap;
  if (!yaml.isMap(rootNode)) {
    throw new Error('Invalid YAML structure: root node must be a mapping');
  }

  let langNode = rootNode.get(languageCode) as YamlMap;

  if (!langNode || !yaml.isMap(langNode)) {
    langNode = yamlDoc.createNode({}) as YamlMap;
    rootNode.set(languageCode, langNode);
  }

  for (const [keyPath, newValue] of Object.entries(translations)) {
    const keys = keyPath.split('.');
    let current = langNode;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current.has(key)) {
        current.set(key, yamlDoc.createNode({}));
      }
      const nextNode = current.get(key, true);
      if (!yaml.isMap(nextNode)) {
        const newNode = yamlDoc.createNode({}) as YamlMap;
        const nestingTerminalPluralCategory = i + 1 === keys.length - 1 &&
          CLDR_PLURAL_CATEGORIES.includes(keys[i + 1]);
        if (nestingTerminalPluralCategory && hasPreservableNode(nextNode)) {
          newNode.set('other', nextNode);
        }
        current.set(key, newNode);
        current = newNode;
      } else {
        current = nextNode as YamlMap;
      }
    }

    const lastKey = keys[keys.length - 1];

    if (Array.isArray(newValue)) {
      const arrayNode = new yaml.YAMLSeq() as YamlSeq;
      processArrayItems(newValue, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    const array = tryParseJsonArray(newValue);
    if (array) {
      const arrayNode = new yaml.YAMLSeq() as YamlSeq;
      processArrayItems(array, yamlDoc).forEach(item => arrayNode.add(item));
      current.set(lastKey, arrayNode);
      continue;
    }

    if (typeof newValue === 'string' && newValue.includes('\n')) {
      const scalar = new yaml.Scalar(newValue) as YamlScalar;
      scalar.type = 'BLOCK_LITERAL';
      current.set(lastKey, scalar);
      continue;
    }

    const node = yamlDoc.createNode(newValue) as YamlScalar;
    const existingNode = current.get(lastKey, true);
    if (needsQuotes(newValue)) {
      node.type = 'QUOTE_DOUBLE';
    } else if (yaml.isScalar(existingNode) && isQuotedType(existingNode.type)) {
      node.type = existingNode.type;
    }
    current.set(lastKey, node);
  }
}

export async function updateYamlFile(
  filePath: string,
  translations: Record<string, unknown>,
  languageCode: string
): Promise<UpdateResult> {
  const exists = await fileExists(filePath);

  if (!exists) {
    const { doc: yamlDoc, created, options } = await createYamlDocument(filePath);
    await updateYamlTranslations(yamlDoc, translations, languageCode);
    await fs.writeFile(filePath, yamlDoc.toString({
      indent: options.indent,
      indentSeq: options.indentSeq,
      lineWidth: LINE_WIDTH
    }));
    return {
      updatedKeys: Object.keys(translations),
      created
    };
  }

  const source = await fs.readFile(filePath, 'utf8');
  const options = detectYamlOptions(source);
  const doc = yaml.parseDocument(source);
  clearDuplicateKeyErrors(doc, filePath);

  if (Object.keys(translations).length === 0) {
    return { updatedKeys: [], created: false };
  }

  const canSplice = !hasUnsupportedValueShape(translations) && doc.contents && yaml.isMap(doc.contents);

  if (canSplice) {
    const { output, applied } = spliceYamlUpdate(source, doc, translations, languageCode, options.indent);
    if (applied) {
      await fs.writeFile(filePath, output);
      return {
        updatedKeys: Object.keys(translations),
        created: false
      };
    }
  }

  await updateYamlTranslations(doc, translations, languageCode);
  await fs.writeFile(filePath, doc.toString({
    indent: options.indent,
    indentSeq: options.indentSeq,
    lineWidth: LINE_WIDTH
  }));
  return {
    updatedKeys: Object.keys(translations),
    created: false
  };
}

export async function deleteKeysFromYamlFile(
  filePath: string,
  keysToDelete: string[],
  languageCode: string
): Promise<string[]> {
  try {
    const source = await fs.readFile(filePath, 'utf8');
    const doc = yaml.parseDocument(source);
    clearDuplicateKeyErrors(doc, filePath);

    const { output, deletedKeys } = spliceYamlDelete(source, doc, keysToDelete, languageCode);
    if (deletedKeys.length > 0) {
      await fs.writeFile(filePath, output);
    }
    return deletedKeys;
  } catch (error) {
    throw new Error(`Failed to delete keys from YAML file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
