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

// Duplicate key names within a single mapping level, keyed by the dotted
// path to that mapping (e.g. "sv.section" -> {"keep_me"}). Only duplicates
// actually present are returned; a map with no repeated keys contributes
// nothing, so an empty result means "no duplicates anywhere in this doc".
function collectDuplicateKeyNames(node: unknown, pathPrefix: string[] = [], acc: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  if (yaml.isMap(node)) {
    const seen = new Map<string, number>();
    for (const item of (node as YamlMap).items) {
      const keyStr = yaml.isScalar(item.key) ? String((item.key as YamlScalar).value) : JSON.stringify(item.key);
      seen.set(keyStr, (seen.get(keyStr) ?? 0) + 1);
      collectDuplicateKeyNames(item.value, [...pathPrefix, keyStr], acc);
    }
    const duplicates = new Set<string>();
    for (const [key, count] of seen) {
      if (count > 1) duplicates.add(key);
    }
    if (duplicates.size > 0) acc.set(pathPrefix.join('.'), duplicates);
  } else if (yaml.isSeq(node)) {
    (node as YamlSeq).items.forEach((item, i) => collectDuplicateKeyNames(item, [...pathPrefix, String(i)], acc));
  }
  return acc;
}

function isSubsetOfExistingDuplicates(
  outputDuplicates: Map<string, Set<string>>,
  sourceDuplicates: Map<string, Set<string>>
): boolean {
  for (const [mapPath, keys] of outputDuplicates) {
    const sourceKeys = sourceDuplicates.get(mapPath);
    if (!sourceKeys) return false;
    for (const key of keys) {
      if (!sourceKeys.has(key)) return false;
    }
  }
  return true;
}

// The splice writer computes byte-range patches by hand rather than a
// round-trip library serialize (see yaml-splicer.ts header comment), so a
// wrong offset/indentation calculation can silently produce syntactically
// invalid YAML (#509). Re-parsing before writing catches that before a
// corrupted file ships; callers fall back to the safe full-document
// rewrite path instead of writing unverified output.
//
// A DUPLICATE_KEY error in the output is only tolerated (warned, not
// blocked) when that exact key, at that exact mapping path, was ALREADY
// duplicated in the source. That matches the tolerance clearDuplicateKeyErrors
// already applies on read (and how Ruby's YAML loader behaves — last-value-wins,
// no crash), without waving through a NEW duplicate a bad splice offset could
// introduce by inserting a key where one with the same name already exists.
interface SpliceValidation {
  valid: boolean;
  reason?: string;
}

function validateSplicedOutput(source: string, output: string, filePath: string): SpliceValidation {
  const reparsed = yaml.parseDocument(output, { strict: true });
  const blockingErrors = reparsed.errors.filter(e => e.code !== 'DUPLICATE_KEY');

  if (blockingErrors.length > 0) {
    return { valid: false, reason: `failed to re-parse (${blockingErrors[0].message})` };
  }

  const outputDuplicates = collectDuplicateKeyNames(reparsed.contents);
  if (outputDuplicates.size === 0) return { valid: true };

  const sourceDoc = yaml.parseDocument(source);
  const sourceDuplicates = collectDuplicateKeyNames(sourceDoc.contents);

  if (!isSubsetOfExistingDuplicates(outputDuplicates, sourceDuplicates)) {
    return { valid: false, reason: 'introduces a new duplicate key not present in the source file' };
  }

  const duplicateCount = [...outputDuplicates.values()].reduce((sum, keys) => sum + keys.size, 0);
  console.warn(
    `Warning: ${filePath} has ${duplicateCount} duplicate key(s) after this write; ` +
    'the source file already had them. YAML parsers using last-value-wins semantics will still ' +
    'read it correctly, but the duplicate keys should be cleaned up.'
  );
  return { valid: true };
}

function clearDuplicateKeyErrors(doc: yaml.Document, filePath: string): void {
  if (doc.errors.length === 0) return;

  const duplicateKeyErrors = doc.errors.filter(e => e.code === 'DUPLICATE_KEY');
  if (duplicateKeyErrors.length === 0) return;

  console.warn(`Warning: ${filePath} has ${duplicateKeyErrors.length} duplicate key(s), using last value for each`);
  doc.errors = doc.errors.filter(e => e.code !== 'DUPLICATE_KEY');
}

/**
 * Keeps an existing folded block scalar folded, so an author's `>-` is not silently rewritten to
 * `|-`. The two are not equivalent: `>-` folds newlines to spaces, `|-` keeps them, so swapping
 * the style changes the parsed value.
 *
 * A folded scalar can only represent the new value when it round-trips: folding collapses single
 * newlines, so a value whose blank lines or indentation carry meaning must fall back to literal
 * rather than lose them.
 */
function preservedBlockType(existingNode: unknown, newValue: string): 'BLOCK_LITERAL' | 'BLOCK_FOLDED' {
  if (!yaml.isScalar(existingNode) || existingNode.type !== 'BLOCK_FOLDED') {
    return 'BLOCK_LITERAL';
  }

  return foldedRoundTrips(newValue) ? 'BLOCK_FOLDED' : 'BLOCK_LITERAL';
}

function foldedRoundTrips(value: string): boolean {
  try {
    // Probe inside a mapping, which is how the value is actually emitted. A bare document scalar
    // indents differently and would not reproduce the folding behaviour we need to check.
    const probe = new yaml.Document();
    probe.contents = probe.createNode({}) as YamlMap;
    const scalar = new yaml.Scalar(value) as YamlScalar;
    scalar.type = 'BLOCK_FOLDED';
    (probe.contents as YamlMap).set('probe', scalar);
    const emitted = probe.toString({ lineWidth: LINE_WIDTH });

    // The value must survive the round-trip, and the emitted YAML must not lean on trailing
    // whitespace to do it — `yaml` encodes a blank line inside a folded scalar as two spaces at
    // the end of a line, which is invisible, fragile, and noise in a review diff.
    if (/[ \t]+$/m.test(emitted)) {
      return false;
    }

    return (yaml.parse(emitted) as Record<string, unknown>).probe === value;
  } catch {
    return false;
  }
}

// Last line of defence: a writer bug that emits unparsable YAML takes down
// the customer's app at boot.
async function writeYamlFile(filePath: string, content: string): Promise<void> {
  const doc = yaml.parseDocument(content);
  clearDuplicateKeyErrors(doc, filePath);
  if (doc.errors.length > 0) {
    throw new Error(
      `Refusing to write invalid YAML to ${filePath}: ${doc.errors[0].message}`
    );
  }
  await fs.writeFile(filePath, content);
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
      scalar.type = preservedBlockType(current.get(lastKey, true), newValue);
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
    await writeYamlFile(filePath, yamlDoc.toString({
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
      const validation = validateSplicedOutput(source, output, filePath);
      if (validation.valid) {
        await writeYamlFile(filePath, output);
        return {
          updatedKeys: Object.keys(translations),
          created: false
        };
      }
      console.warn(
        `Warning: splice-writer output for ${filePath} ${validation.reason}; falling back to full-document rewrite.`
      );
    }
  }

  await updateYamlTranslations(doc, translations, languageCode);
  await writeYamlFile(filePath, doc.toString({
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
      const validation = validateSplicedOutput(source, output, filePath);
      if (!validation.valid) {
        throw new Error(
          `Splice-writer output ${validation.reason}, and deletion has no full-rewrite fallback; file was not modified`
        );
      }
      await writeYamlFile(filePath, output);
    }
    return deletedKeys;
  } catch (error) {
    throw new Error(`Failed to delete keys from YAML file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
