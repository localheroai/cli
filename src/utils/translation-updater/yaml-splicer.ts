/**
 * Byte-range splice writer for YAML files.
 *
 * Why this exists: `yaml@2.x` does not preserve original line layout on
 * round-trip. Plain scalars written across multiple lines (no `>` / `|`
 * marker) parse with no metadata distinguishing them from single-line plain
 * scalars, and the emitter decides line layout purely from `lineWidth`. The
 * maintainer's position is that lossless round-trip is out of scope for the
 * Document API (eemeli/yaml discussion #510, issue #392 closed as not
 * planned). For our use case we must not reformat scalars we did not touch,
 * so we work around this by computing byte-range patches and splicing them
 * into the original source.
 */
import yaml from 'yaml';
import { tryParseJsonArray } from './common.js';

type YamlMap = yaml.YAMLMap;
type YamlNode = yaml.Node | yaml.YAMLMap | yaml.YAMLSeq | yaml.Scalar;
type YamlScalar = yaml.Scalar;

interface Patch {
  start: number;
  end: number;
  text: string;
}

interface NavigationResult {
  found: boolean;
  scalarNode?: YamlScalar;
  insertionParent?: YamlMap;
  insertionParentRange?: [number, number, number];
  remainingPath?: string[];
  typeCollision?: boolean;
}

interface ParentContext {
  column: number;
  insertionOffset: number;
}

interface SpliceResult {
  output: string;
  applied: boolean;
}

function getNodeRange(node: unknown): [number, number, number] | null {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: [number, number, number] }).range;
    if (Array.isArray(range) && range.length === 3) {
      return range;
    }
  }
  return null;
}

function columnOfOffset(source: string, offset: number): number {
  let col = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (source[i] === '\n') break;
    col++;
  }
  return col;
}

function lineStartColumnOf(source: string, offset: number): number {
  let lineStart = offset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') {
    lineStart--;
  }
  let col = 0;
  while (lineStart + col < source.length && (source[lineStart + col] === ' ' || source[lineStart + col] === '\t')) {
    col++;
  }
  return col;
}

const SCALAR_KEY = '__lh_scalar__';

function emitScalarViaLibrary(
  value: unknown,
  existingType: string | null,
  indentUnit: number
): string {
  const doc = new yaml.Document();
  doc.contents = doc.createNode({}) as YamlMap;
  const rootMap = doc.contents as YamlMap;

  if (typeof value === 'string' && !value.includes('\n') &&
      (existingType === 'QUOTE_SINGLE' || existingType === 'QUOTE_DOUBLE')) {
    const scalar = new yaml.Scalar(value);
    scalar.type = existingType;
    rootMap.set(SCALAR_KEY, scalar);
  } else {
    rootMap.set(SCALAR_KEY, doc.createNode(value));
  }

  return doc.toString({ indent: indentUnit, lineWidth: 0 });
}

function indentContinuationLines(text: string, extraIndent: number): string {
  if (extraIndent === 0) return text;
  const pad = ' '.repeat(extraIndent);
  const lines = text.split('\n');
  return lines
    .map((line, idx) => (idx === 0 || line.length === 0) ? line : pad + line)
    .join('\n');
}

function indentAllLines(text: string, extraIndent: number): string {
  if (extraIndent === 0) return text;
  const pad = ' '.repeat(extraIndent);
  return text
    .split('\n')
    .map(line => line.length > 0 ? pad + line : line)
    .join('\n');
}

function serializeScalarValue(
  value: unknown,
  existingType: string | null,
  keyColumn: number,
  indentUnit: number
): string {
  const emitted = emitScalarViaLibrary(value, existingType, indentUnit);
  const prefix = `${SCALAR_KEY}: `;
  const prefixIdx = emitted.indexOf(prefix);
  if (prefixIdx < 0) {
    return JSON.stringify(value);
  }
  const valueText = emitted.slice(prefixIdx + prefix.length).replace(/\n$/, '');
  return indentContinuationLines(valueText, keyColumn);
}

function navigatePath(doc: yaml.Document, fullPath: string[]): NavigationResult {
  if (!doc.contents || !yaml.isMap(doc.contents)) {
    return { found: false };
  }

  let current: YamlMap = doc.contents as YamlMap;
  let lastFoundMap: YamlMap = current;
  let lastFoundRange = getNodeRange(current);

  for (let i = 0; i < fullPath.length; i++) {
    const key = fullPath[i];
    if (!current.has(key)) {
      return {
        found: false,
        insertionParent: lastFoundMap,
        insertionParentRange: lastFoundRange ?? undefined,
        remainingPath: fullPath.slice(i)
      };
    }

    const next = current.get(key, true);
    const isLast = i === fullPath.length - 1;

    if (isLast) {
      if (yaml.isScalar(next)) {
        return { found: true, scalarNode: next };
      }
      return {
        found: false,
        typeCollision: true
      };
    }

    if (!yaml.isMap(next)) {
      return {
        found: false,
        typeCollision: true,
        insertionParent: lastFoundMap,
        insertionParentRange: lastFoundRange ?? undefined,
        remainingPath: fullPath.slice(i)
      };
    }

    current = next as YamlMap;
    lastFoundMap = current;
    lastFoundRange = getNodeRange(current);
  }

  return { found: false };
}

type InsertionTreeLeaf = { __leaf__: true; value: unknown };
type InsertionTreeNode = Map<string, InsertionTreeNode | InsertionTreeLeaf>;

function isLeaf(node: InsertionTreeNode | InsertionTreeLeaf): node is InsertionTreeLeaf {
  return (node as InsertionTreeLeaf).__leaf__ === true;
}

function insertIntoTree(tree: InsertionTreeNode, path: string[], value: unknown): void {
  if (path.length === 0) return;
  let current = tree;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const existing = current.get(key);
    if (!existing || isLeaf(existing)) {
      const next: InsertionTreeNode = new Map();
      current.set(key, next);
      current = next;
    } else {
      current = existing;
    }
  }
  current.set(path[path.length - 1], { __leaf__: true, value });
}

function treeToPlainObject(tree: InsertionTreeNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of tree.entries()) {
    out[key] = isLeaf(node) ? node.value : treeToPlainObject(node);
  }
  return out;
}

function buildInsertionTextFromTree(
  tree: InsertionTreeNode,
  parentColumn: number,
  indentUnit: number
): string {
  const plain = treeToPlainObject(tree);
  const doc = new yaml.Document();
  doc.contents = doc.createNode(plain);
  const emitted = doc.toString({ indent: indentUnit, lineWidth: 0 });
  return indentAllLines(emitted, parentColumn);
}

function ensureAfterNewline(source: string, offset: number): number {
  if (offset > 0 && source[offset - 1] === '\n') return offset;
  let scan = offset;
  while (scan < source.length && source[scan] !== '\n') scan++;
  if (scan < source.length) return scan + 1;
  return source.length;
}

function findInsertionOffset(
  source: string,
  parent: YamlMap,
  parentRange: [number, number, number] | undefined
): number {
  const items = parent.items;
  if (items.length > 0) {
    const lastItem = items[items.length - 1];
    const lastValue = lastItem.value as YamlNode | null;
    const lastValueRange = lastValue ? getNodeRange(lastValue) : null;
    if (lastValueRange) return ensureAfterNewline(source, lastValueRange[2]);

    const lastKeyRange = getNodeRange(lastItem.key as YamlNode);
    if (lastKeyRange) return ensureAfterNewline(source, lastKeyRange[2]);
  }

  if (parentRange) return ensureAfterNewline(source, parentRange[2]);
  return source.length;
}

function resolveParentContext(
  source: string,
  parent: YamlMap,
  parentRange: [number, number, number] | undefined,
  indentUnit: number
): ParentContext {
  let column = 0;

  if (parent.items.length > 0) {
    const firstChild = parent.items[0];
    const firstKeyRange = getNodeRange(firstChild.key as YamlNode);
    column = firstKeyRange ? columnOfOffset(source, firstKeyRange[0]) : indentUnit;
  } else if (parentRange) {
    column = columnOfOffset(source, parentRange[0]) + indentUnit;
  }

  const insertionOffset = findInsertionOffset(source, parent, parentRange);
  return { column, insertionOffset };
}

function applyPatches(source: string, patches: Patch[]): string {
  const sorted = [...patches].sort((a, b) => b.start - a.start);
  let result = source;
  for (const patch of sorted) {
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  }
  return result;
}

export function hasUnsupportedValueShape(translations: Record<string, unknown>): boolean {
  for (const value of Object.values(translations)) {
    if (Array.isArray(value)) return true;
    if (typeof value === 'string' && tryParseJsonArray(value)) return true;
  }
  return false;
}

export function spliceYamlUpdate(
  source: string,
  doc: yaml.Document,
  translations: Record<string, unknown>,
  languageCode: string,
  indentUnit: number
): SpliceResult {
  if (!doc.contents || !yaml.isMap(doc.contents)) {
    return { output: source, applied: false };
  }

  const patches: Patch[] = [];
  const insertGroups = new Map<string, {
    parent: YamlMap;
    parentRange: [number, number, number] | undefined;
    tree: InsertionTreeNode;
  }>();

  for (const [keyPath, value] of Object.entries(translations)) {
    const pathParts = [languageCode, ...keyPath.split('.')];
    const nav = navigatePath(doc, pathParts);

    if (nav.typeCollision) {
      return { output: source, applied: false };
    }

    if (nav.found && nav.scalarNode) {
      const existingType = nav.scalarNode.type ?? null;
      if (existingType === 'BLOCK_LITERAL' || existingType === 'BLOCK_FOLDED') {
        return { output: source, applied: false };
      }

      const range = getNodeRange(nav.scalarNode);
      if (!range) {
        return { output: source, applied: false };
      }
      const keyColumn = lineStartColumnOf(source, range[0]);
      const serialized = serializeScalarValue(value, existingType, keyColumn, indentUnit);
      const gluedToColon = range[0] > 0 && source[range[0] - 1] === ':';
      const leadingSeparator = gluedToColon ? ' ' : '';
      const followedByComment = source[range[1]] === '#';
      const trailingSeparator = followedByComment ? ' ' : '';
      patches.push({ start: range[0], end: range[1], text: leadingSeparator + serialized + trailingSeparator });
      continue;
    }

    if (!nav.insertionParent || !nav.remainingPath || nav.remainingPath.length === 0) {
      return { output: source, applied: false };
    }

    const parentKey = `${(nav.insertionParentRange ?? [0])[0]}`;
    let group = insertGroups.get(parentKey);
    if (!group) {
      group = {
        parent: nav.insertionParent,
        parentRange: nav.insertionParentRange,
        tree: new Map()
      };
      insertGroups.set(parentKey, group);
    }
    insertIntoTree(group.tree, nav.remainingPath, value);
  }

  for (const group of insertGroups.values()) {
    const ctx = resolveParentContext(source, group.parent, group.parentRange, indentUnit);
    const text = buildInsertionTextFromTree(group.tree, ctx.column, indentUnit);
    if (text.length > 0) {
      const insertStart = ctx.insertionOffset;
      const prefix = insertStart > 0 && source[insertStart - 1] !== '\n' ? '\n' : '';
      patches.push({ start: insertStart, end: insertStart, text: prefix + text });
    }
  }

  return { output: applyPatches(source, patches), applied: true };
}

interface DeletionTarget {
  keyPath: string;
  parentMap: YamlMap;
  leafKey: string;
  leafItem: yaml.Pair;
  ancestorChain: Array<{ map: YamlMap; keyName: string; itemInParent: yaml.Pair }>;
}

function locateDeletionTarget(
  doc: yaml.Document,
  keyPath: string,
  fullPath: string[]
): DeletionTarget | null {
  if (!doc.contents || !yaml.isMap(doc.contents)) return null;

  let current: YamlMap = doc.contents as YamlMap;
  const ancestorChain: Array<{ map: YamlMap; keyName: string; itemInParent: yaml.Pair }> = [];

  for (let i = 0; i < fullPath.length - 1; i++) {
    const key = fullPath[i];
    const itemInParent = current.items.find(it => {
      const k = it.key as { value?: unknown } | null;
      return k && k.value === key;
    });
    if (!itemInParent) return null;
    const next = itemInParent.value;
    if (!yaml.isMap(next)) return null;
    ancestorChain.push({ map: current, keyName: key, itemInParent });
    current = next as YamlMap;
  }

  const leafKey = fullPath[fullPath.length - 1];
  const leafItem = current.items.find(it => {
    const k = it.key as { value?: unknown } | null;
    return k && k.value === leafKey;
  });
  if (!leafItem) return null;

  return { keyPath, parentMap: current, leafKey, leafItem, ancestorChain };
}

function computeDeletionRange(
  source: string,
  keyRange: [number, number, number],
  nodeEnd: number
): { start: number; end: number } {
  let start = keyRange[0];
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
    start--;
  }
  let end = nodeEnd;
  if (end > 0 && source[end - 1] !== '\n') {
    while (end < source.length && (source[end] === ' ' || source[end] === '\t')) {
      end++;
    }
    if (end < source.length && source[end] === '\n') {
      end++;
    }
  }
  return { start, end };
}

function patchForItem(source: string, item: yaml.Pair): Patch | null {
  const keyRange = getNodeRange(item.key as YamlNode);
  if (!keyRange) return null;
  const valueRange = item.value ? getNodeRange(item.value as YamlNode) : null;
  const nodeEnd = valueRange ? valueRange[2] : keyRange[2];
  const { start, end } = computeDeletionRange(source, keyRange, nodeEnd);
  return { start, end, text: '' };
}

export interface SpliceDeleteResult {
  output: string;
  deletedKeys: string[];
}

export function spliceYamlDelete(
  source: string,
  doc: yaml.Document,
  keysToDelete: string[],
  languageCode: string
): SpliceDeleteResult {
  if (!doc.contents || !yaml.isMap(doc.contents) || !(doc.contents as YamlMap).has(languageCode)) {
    return { output: source, deletedKeys: [] };
  }

  const targets: DeletionTarget[] = [];
  for (const keyPath of keysToDelete) {
    const fullPath = [languageCode, ...keyPath.split('.')];
    const target = locateDeletionTarget(doc, keyPath, fullPath);
    if (target) targets.push(target);
  }

  if (targets.length === 0) {
    return { output: source, deletedKeys: [] };
  }

  const deletionsByParent = new Map<YamlMap, Set<string>>();
  for (const target of targets) {
    let set = deletionsByParent.get(target.parentMap);
    if (!set) {
      set = new Set<string>();
      deletionsByParent.set(target.parentMap, set);
    }
    set.add(target.leafKey);
  }

  const collapsedMaps = new Set<YamlMap>();
  for (const target of targets) {
    const parentSet = deletionsByParent.get(target.parentMap)!;
    const parentAllDeleted = target.parentMap.items.every(it => {
      const k = it.key as { value?: unknown } | null;
      return k && parentSet.has(k.value as string);
    });
    if (!parentAllDeleted) continue;

    collapsedMaps.add(target.parentMap);

    for (let i = target.ancestorChain.length - 1; i >= 0; i--) {
      const ancestor = target.ancestorChain[i];
      const childMap = i === target.ancestorChain.length - 1
        ? target.parentMap
        : target.ancestorChain[i + 1].map;
      if (!collapsedMaps.has(childMap)) break;

      const ancestorMap = ancestor.map;
      const onlyOneChild = ancestorMap.items.length === 1;
      const matches = ancestorMap.items.every(it => {
        const k = it.key as { value?: unknown } | null;
        return k && k.value === ancestor.keyName;
      });
      if (onlyOneChild && matches) {
        collapsedMaps.add(ancestorMap);
      } else {
        break;
      }
    }
  }

  const patches: Patch[] = [];
  const emittedItems = new Set<yaml.Pair>();

  for (const target of targets) {
    let outermostCollapsedItem: yaml.Pair | null = null;
    for (let i = target.ancestorChain.length - 1; i >= 0; i--) {
      const ancestor = target.ancestorChain[i];
      const childMap = i === target.ancestorChain.length - 1
        ? target.parentMap
        : target.ancestorChain[i + 1].map;
      if (collapsedMaps.has(childMap)) {
        outermostCollapsedItem = ancestor.itemInParent;
      } else {
        break;
      }
    }

    const itemToEmit = outermostCollapsedItem ?? target.leafItem;
    if (emittedItems.has(itemToEmit)) continue;

    const patch = patchForItem(source, itemToEmit);
    if (patch) {
      patches.push(patch);
      emittedItems.add(itemToEmit);
    }
  }

  const deletedKeys = targets.map(t => t.keyPath);
  return { output: applyPatches(source, patches), deletedKeys };
}
