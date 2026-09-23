import { placeholderMultiset } from './placeholders.js';

export type FlatValue = unknown;
export type FlatMap = Record<string, FlatValue>;

/** Unwraps a .po-style {value, context?, metadata?} leaf down to its string. */
export function toStringValue(entry: FlatValue): string | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (Array.isArray(entry)) return null;
  if (typeof entry === 'object' && 'value' in entry) return toStringValue(entry.value);
  return null;
}

function shapeOf(entry: FlatValue): 'string' | 'array' | 'map' | 'empty' {
  if (entry === null || entry === undefined) return 'empty';
  if (Array.isArray(entry)) return 'array';
  if (typeof entry === 'object' && !('value' in entry)) return 'map';
  return 'string';
}

export interface OrphanFinding {
  key: string;
  target: string | null;
}

export function findOrphanKeys(sourceKeys: FlatMap, targetKeys: FlatMap): OrphanFinding[] {
  const orphans: OrphanFinding[] = [];
  const sourcePluralBases = gettextPluralBases(Object.keys(sourceKeys));
  const sourcePluralGroups = railsPluralGroups(sourceKeys);
  for (const key of Object.keys(targetKeys)) {
    // Arabic has six plural forms where English has two; the extra ones are not leftovers.
    const extraPluralForm =
      GETTEXT_PLURAL_SUFFIX.test(key) && sourcePluralBases.has(key.replace(GETTEXT_PLURAL_SUFFIX, ''));
    // Polish `few`/`many` under an English `one`/`other` group are what the language needs.
    const railsPluralForm = RAILS_PLURAL_LEAVES.has(leafOf(key)) && sourcePluralGroups.has(parentOf(key));
    if (!(key in sourceKeys) && !extraPluralForm && !railsPluralForm) {
      orphans.push({ key, target: toStringValue(targetKeys[key]) });
    }
  }
  return orphans;
}

export interface PlaceholderMismatch {
  hint?: boolean;
  key: string;
  source: string;
  target: string;
  missingInTarget: string[];
  unexpectedInTarget: string[];
}

/**
 * A `zero`/`one`/`two` form may omit a placeholder ("1 språk" for "%{count} language"), as may any
 * numbered gettext form. Such omissions are hints; anything else, including an added placeholder, is a mismatch.
 */
export function findPlaceholderMismatches(sourceKeys: FlatMap, targetKeys: FlatMap): PlaceholderMismatch[] {
  const mismatches: PlaceholderMismatch[] = [];
  const pluralBases = gettextPluralBases([...Object.keys(sourceKeys), ...Object.keys(targetKeys)]);
  for (const key of Object.keys(sourceKeys)) {
    const source = toStringValue(sourceKeys[key]);
    if (source === null || source === '') continue;
    const target = toStringValue(targetKeys[key]);
    if (target === null || target === '') continue;

    const sourceCounts = placeholderMultiset(source);
    const targetCounts = placeholderMultiset(target);
    if (sourceCounts.size === 0 && targetCounts.size === 0) continue;

    const missingInTarget: string[] = [];
    const unexpectedInTarget: string[] = [];

    for (const [token, count] of sourceCounts) {
      if ((targetCounts.get(token) ?? 0) < count) missingInTarget.push(token);
    }
    for (const [token, count] of targetCounts) {
      if ((sourceCounts.get(token) ?? 0) < count) unexpectedInTarget.push(token);
    }

    if (missingInTarget.length === 0 && unexpectedInTarget.length === 0) continue;

    // A gettext singular is compared against whichever form the target language puts first.
    const omissionInPluralForm =
      unexpectedInTarget.length === 0 && (mayOmitPlaceholder(key) || pluralBases.has(key));
    mismatches.push({
      key,
      source,
      target,
      missingInTarget,
      unexpectedInTarget,
      ...(omissionInPluralForm ? { hint: true } : {})
    });
  }
  return mismatches;
}

export interface StructureMismatch {
  key: string;
  sourceShape: string;
  targetShape: string;
}

/**
 * Flattening turns a target map into child keys, so a source string that is only a parent in the
 * target became a map. A target that pluralizes a flat string is allowed, as Rails supports that.
 */
export function findStructureMismatches(sourceKeys: FlatMap, targetKeys: FlatMap): StructureMismatch[] {
  const mismatches: StructureMismatch[] = [];
  const targetChildren = childLeavesByParent(Object.keys(targetKeys));
  for (const key of Object.keys(sourceKeys)) {
    const sourceShape = shapeOf(sourceKeys[key]);
    if (!(key in targetKeys)) {
      const children = targetChildren.get(key);
      if (sourceShape === 'string' && children && !isPluralLeafSet(children)) {
        mismatches.push({ key, sourceShape, targetShape: 'map' });
      }
      continue;
    }
    const targetShape = shapeOf(targetKeys[key]);
    if (sourceShape === 'empty' || targetShape === 'empty') continue;
    if (sourceShape !== targetShape) {
      mismatches.push({ key, sourceShape, targetShape });
    }
  }
  return mismatches;
}

export function findPluralizedFlatKeys(sourceKeys: FlatMap, targetKeys: FlatMap): string[] {
  const targetChildren = childLeavesByParent(Object.keys(targetKeys));
  return Object.keys(sourceKeys).filter((key) => {
    const children = targetChildren.get(key);
    return !(key in targetKeys) && shapeOf(sourceKeys[key]) === 'string' && children && isPluralLeafSet(children);
  });
}

function childLeavesByParent(keys: string[]): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  for (const key of keys) {
    let end = key.lastIndexOf('.');
    let child = key.slice(end + 1);
    while (end !== -1) {
      const parent = key.slice(0, end);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(child);
      child = parent.slice(parent.lastIndexOf('.') + 1);
      end = parent.lastIndexOf('.');
    }
  }
  return children;
}

function isPluralLeafSet(leaves: Set<string>): boolean {
  return [...leaves].every((leaf) => RAILS_PLURAL_LEAVES.has(leaf));
}

/** Mirrors po-utils.ts's PLURAL_PREFIX; not imported so this module stays free of parser dependencies. */
const GETTEXT_PLURAL_SUFFIX = /__plural_\d+$/;

const COUNT_OPTIONAL_CATEGORIES = ['zero', 'one', 'two'];

function mayOmitPlaceholder(key: string): boolean {
  if (GETTEXT_PLURAL_SUFFIX.test(key)) return true;
  const leaf = leafOf(key);
  return COUNT_OPTIONAL_CATEGORIES.some((category) => leaf === category || leaf.endsWith(`_${category}`));
}

function gettextPluralBases(keys: string[]): Set<string> {
  const bases = new Set<string>();
  for (const key of keys) {
    if (GETTEXT_PLURAL_SUFFIX.test(key)) bases.add(key.replace(GETTEXT_PLURAL_SUFFIX, ''));
  }
  return bases;
}

const RAILS_PLURAL_LEAVES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const I18NEXT_PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other', '_plural'];

// A lone `status.other` is not a plural group (see translation-utils.ts's isPluralForm);
// it takes at least two CLDR-category siblings under one parent.
function pluralParentsOf(keys: string[]): Set<string> {
  const railsCandidates = new Map<string, Set<string>>();
  const i18nextParents = new Set<string>();

  for (const key of keys) {
    const lastDot = key.lastIndexOf('.');
    const leaf = leafOf(key);
    const parent = lastDot === -1 ? '' : key.slice(0, lastDot);
    if (RAILS_PLURAL_LEAVES.has(leaf)) {
      if (!railsCandidates.has(parent)) railsCandidates.set(parent, new Set());
      railsCandidates.get(parent)!.add(leaf);
      continue;
    }
    for (const suffix of I18NEXT_PLURAL_SUFFIXES) {
      if (leaf.endsWith(suffix)) {
        const base = leaf.slice(0, -suffix.length);
        i18nextParents.add(parent ? `${parent}.${base}` : base);
      }
    }
  }

  const parents = new Set<string>(i18nextParents);
  for (const [parent, categories] of railsCandidates) {
    if (categories.size >= 2) parents.add(parent);
  }
  return parents;
}

export interface PluralShapeMismatch {
  key: string;
}

/** A source plural group the target has content for but no plural forms; with no content it is simply missing. */
export function findPluralShapeMismatches(sourceKeys: FlatMap, targetKeys: FlatMap): PluralShapeMismatch[] {
  const sourceParents = pluralParentsOf(Object.keys(sourceKeys));
  const targetParents = pluralParentsOf(Object.keys(targetKeys));
  const targetKeyList = Object.keys(targetKeys);

  const mismatches: PluralShapeMismatch[] = [];
  for (const parent of sourceParents) {
    if (targetParents.has(parent)) continue;
    const hasAnyTargetKeyUnderParent = targetKeyList.some((k) => k === parent || k.startsWith(`${parent}.`));
    if (hasAnyTargetKeyUnderParent) {
      mismatches.push({ key: parent });
    }
  }
  return mismatches;
}

export interface EmptyFinding {
  key: string;
  source: string;
}

export interface IdenticalFinding {
  key: string;
  value: string;
}

/** Identical text is only a hint, never an error: short words and proper nouns are often the same across languages. */
export function findEmptyAndIdentical(
  sourceKeys: FlatMap,
  targetKeys: FlatMap
): { empty: EmptyFinding[]; identical: IdenticalFinding[] } {
  const empty: EmptyFinding[] = [];
  const identical: IdenticalFinding[] = [];

  for (const key of Object.keys(sourceKeys)) {
    const source = toStringValue(sourceKeys[key]);
    if (source === null || source === '') continue;
    if (!(key in targetKeys)) continue;
    const target = toStringValue(targetKeys[key]);
    if (target === '') {
      empty.push({ key, source });
    } else if (target === source) {
      identical.push({ key, value: source });
    }
  }

  return { empty, identical };
}

export interface MissingPluralCategories {
  key: string;
  missing: string[];
}

/** E.g. Polish without `few`/`many`: Rails silently falls back to `other`, rendering fluent but wrong text. */
export function findMissingPluralCategories(targetKeys: FlatMap, locale: string): MissingPluralCategories[] {
  const required = usedPluralCategories(locale);
  if (!required) return [];
  const findings: MissingPluralCategories[] = [];
  for (const [key, present] of railsPluralGroups(targetKeys)) {
    const missing = required.filter((category) => !present.has(category));
    if (missing.length) findings.push({ key, missing });
  }
  return findings;
}

export interface ConflictingKey {
  key: string;
  files: string[];
  values: string[];
}

/**
 * Rails merges every YAML file of a locale into one namespace, so a key defined twice with
 * different values silently takes whichever file loads last. `values[i]` is the value in `files[i]`.
 */
export function findConflictingKeys(files: { path: string; keys: FlatMap }[]): ConflictingKey[] {
  const definitions = new Map<string, { files: string[]; values: string[] }>();
  for (const { path, keys } of files) {
    for (const [key, entry] of Object.entries(keys)) {
      const value = Array.isArray(entry) ? JSON.stringify(entry) : toStringValue(entry);
      if (value === null) continue;
      if (!definitions.has(key)) definitions.set(key, { files: [], values: [] });
      const definition = definitions.get(key)!;
      definition.files.push(path);
      definition.values.push(value);
    }
  }

  const conflicts: ConflictingKey[] = [];
  for (const [key, definition] of definitions) {
    if (new Set(definition.values).size > 1) conflicts.push({ key, ...definition });
  }
  return conflicts;
}

function leafOf(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

function parentOf(key: string): string {
  return key.slice(0, key.lastIndexOf('.'));
}

/** Rails plural groups: a parent with `other` plus at least one more plural leaf. */
function railsPluralGroups(keys: FlatMap): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const key of Object.keys(keys)) {
    const leaf = leafOf(key);
    if (!key.includes('.') || !RAILS_PLURAL_LEAVES.has(leaf)) continue;
    const parent = parentOf(key);
    if (!groups.has(parent)) groups.set(parent, new Set());
    groups.get(parent)!.add(leaf);
  }
  for (const [parent, leaves] of groups) {
    if (!leaves.has('other') || leaves.size < 2) groups.delete(parent);
  }
  return groups;
}

/**
 * Null for an unknown locale. Only categories reached by 0..1000 count: CLDR gives es/fr/it/pt
 * a `many` for 1,000,000 that rails-i18n does not implement and no one writes.
 */
export function usedPluralCategories(locale: string): string[] | null {
  try {
    const rules = new Intl.PluralRules(locale);
    const reached = new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)));
    return rules.resolvedOptions().pluralCategories.filter((category) => reached.has(category));
  } catch {
    return null;
  }
}
