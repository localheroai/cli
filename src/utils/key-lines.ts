import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';
import { PLURAL_SUFFIX_REGEX, createUniqueKey, parsePoFile } from './po-utils.js';

interface KeyEntry {
  line: number;
  children: KeyTree | null;
}

type KeyTree = Map<string, KeyEntry>;

export type KeyLineLookup = (key: string) => number | null;

const NO_LINES: KeyLineLookup = () => null;

/**
 * Parses a translation file once and returns a lookup for the 1-based line
 * where a key, as check reports it, is defined. The lookup returns null when
 * the line cannot be pinned down with certainty, since a wrong line is worse
 * than none.
 */
export function keyLineFinder(content: string, format: string, locale?: string): KeyLineLookup {
  try {
    switch (format) {
    case 'yml':
    case 'yaml':
      return treeLookup(yamlTree(content), locale);
    case 'json':
      return treeLookup(jsonTree(content), locale);
    case 'po':
    case 'pot':
      return poLookup(content);
    default:
      return NO_LINES;
    }
  } catch {
    return NO_LINES;
  }
}

function treeLookup(tree: KeyTree | null, locale?: string): KeyLineLookup {
  if (!tree) return NO_LINES;
  const wrapper = locale === undefined ? undefined : tree.get(locale);
  const root = wrapper?.children ?? tree;
  return (key) => {
    const lines = new Set(matchLines(root, key.split('.')));
    return lines.size === 1 ? [...lines][0] : null;
  };
}

// Keys are flattened with dots, so a key's own dots and nesting look the same:
// "a.b.c" may be a > b > c, "a.b" > c or a > "b.c". Every split is tried.
function matchLines(tree: KeyTree, segments: string[]): number[] {
  const lines: number[] = [];
  for (let taken = 1; taken <= segments.length; taken++) {
    const entry = tree.get(segments.slice(0, taken).join('.'));
    if (!entry) continue;
    if (taken === segments.length) {
      lines.push(entry.line);
    } else if (entry.children) {
      lines.push(...matchLines(entry.children, segments.slice(taken)));
    }
  }
  return lines;
}

// Repeated keys overwrite, as they do when the file is loaded.
function yamlTree(content: string): KeyTree | null {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0) return null;

  const toTree = (node: unknown): KeyTree | null => {
    if (!isMap(node)) return null;
    const tree: KeyTree = new Map();
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      tree.set(String(pair.key.value), {
        line: lineCounter.linePos(pair.key.range[0]).line,
        children: toTree(pair.value)
      });
    }
    return tree;
  };
  return toTree(doc.contents);
}

// Scans JSON that JSON.parse has already accepted, so it only tracks positions
// and does not validate. Repeated keys overwrite, as in JSON.parse.
function jsonTree(content: string): KeyTree | null {
  JSON.parse(content);
  let pos = 0;
  let line = 1;

  const skipWhitespace = (): void => {
    while (/\s/.test(content[pos] ?? '')) {
      if (content[pos] === '\n') line++;
      pos++;
    }
  };

  const skipSeparator = (): void => {
    skipWhitespace();
    if (content[pos] === ',') pos++;
    skipWhitespace();
  };

  const readString = (): string => {
    const start = pos;
    pos++;
    while (content[pos] !== '"') {
      pos += content[pos] === '\\' ? 2 : 1;
    }
    pos++;
    return JSON.parse(content.slice(start, pos));
  };

  const readArray = (): void => {
    pos++;
    skipWhitespace();
    while (content[pos] !== ']') {
      readValue();
      skipSeparator();
    }
    pos++;
  };

  const readObject = (): KeyTree => {
    const tree: KeyTree = new Map();
    pos++;
    skipWhitespace();
    while (content[pos] !== '}') {
      const keyLine = line;
      const key = readString();
      skipWhitespace();
      pos++;
      tree.set(key, { line: keyLine, children: readValue() });
      skipSeparator();
    }
    pos++;
    return tree;
  };

  const readValue = (): KeyTree | null => {
    skipWhitespace();
    const char = content[pos];
    if (char === '{') return readObject();
    if (char === '[') {
      readArray();
    } else if (char === '"') {
      readString();
    } else {
      while (pos < content.length && !/[\s,\]}]/.test(content[pos])) pos++;
    }
    return null;
  };

  return readValue();
}

interface PoField {
  name: 'msgctxt' | 'msgid' | 'other';
  value: string;
}

const PO_STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const PO_KEYWORD_LINE = new RegExp(`^(msgctxt|msgid|msgid_plural|msgstr(?:\\[\\d+\\])?)\\s*${PO_STRING}$`);
const PO_CONTINUATION_LINE = new RegExp(`^${PO_STRING}$`);
const PO_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function unescapePo(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => PO_ESCAPES[char] ?? char);
}

// Line of each msgid, keyed as createUniqueKey keys it. Obsolete (#~) entries
// are skipped as comments; gettext-parser keeps them out of the catalog too.
function poMsgidLines(content: string): Map<string, number> | null {
  const lines = new Map<string, number>();
  let context = '';
  let msgid: { value: string; line: number } | null = null;
  let field: PoField | null = null;

  const closeEntry = (): void => {
    if (msgid) lines.set(createUniqueKey(msgid.value, context), msgid.line);
    msgid = null;
    context = '';
  };

  const rows = content.split(/\r?\n/);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index].trim();
    if (row === '' || row.startsWith('#')) {
      field = null;
      continue;
    }
    const keyword = row.match(PO_KEYWORD_LINE);
    const continuation = row.match(PO_CONTINUATION_LINE);
    if (keyword) {
      const [, name, raw] = keyword;
      if (name === 'msgctxt' || name === 'msgid') {
        if (name === 'msgctxt' || msgid) closeEntry();
        field = { name, value: unescapePo(raw) };
        if (name === 'msgctxt') context = field.value;
        else msgid = { value: field.value, line: index + 1 };
      } else {
        field = { name: 'other', value: '' };
      }
    } else if (continuation && field) {
      field.value += unescapePo(continuation[1]);
      if (field.name === 'msgctxt') context = field.value;
      if (field.name === 'msgid' && msgid) msgid.value = field.value;
    } else {
      return null;
    }
  }
  closeEntry();
  return lines;
}

function poLookup(content: string): KeyLineLookup {
  const lines = poMsgidLines(content);
  if (!lines) return NO_LINES;
  const pluralByKey = new Map(
    parsePoFile(content).entries.map((entry) => [createUniqueKey(entry.msgid, entry.msgctxt), Boolean(entry.msgid_plural)])
  );

  return (key) => {
    if (pluralByKey.has(key)) return lines.get(key) ?? null;
    const baseKey = key.replace(PLURAL_SUFFIX_REGEX, '');
    if (baseKey !== key && pluralByKey.get(baseKey)) return lines.get(baseKey) ?? null;
    return null;
  };
}
