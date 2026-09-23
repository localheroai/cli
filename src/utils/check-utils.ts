import { placeholderMultiset } from './placeholders.js';

/**
 * Pure, dependency-free checks over flattened key->value maps (the same
 * shape `flattenTranslations` produces). Each function takes a source map
 * and a target map and returns a plain list of findings; none of them read
 * files, call the network, or know about the CLI's config or reporting.
 */

export type FlatValue = unknown;
export type FlatMap = Record<string, FlatValue>;

/** Unwraps a .po-style {value, context?, metadata?} leaf down to its string. */
export function toStringValue(entry: FlatValue): string | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (Array.isArray(entry)) return null;
  if (typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)) {
    return toStringValue((entry as Record<string, unknown>).value);
  }
  return null;
}

function shapeOf(entry: FlatValue): 'string' | 'array' | 'map' | 'empty' {
  if (entry === null || entry === undefined) return 'empty';
  if (Array.isArray(entry)) return 'array';
  if (typeof entry === 'object' && !('value' in (entry as Record<string, unknown>))) return 'map';
  return 'string';
}

export interface OrphanFinding {
  key: string;
  target: string | null;
}

/** Keys present in the target but no longer present in the source. */
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
  /** True when the only difference is a placeholder the plural form omits. */
  hint?: boolean;
  key: string;
  source: string;
  target: string;
  missingInTarget: string[];
  unexpectedInTarget: string[];
}

/**
 * Compares interpolation placeholders in the source string against the
 * target string. Only scalar leaves with an actual value on both sides are
 * checked; a missing target is reported separately by `findMissingKeys`.
 *
 * A plural form is allowed to omit a placeholder the source uses. Rails only
 * renders `one` when the count is 1, so "1 språk" for "%{count} language" is
 * correct, and Arabic's `zero` form legitimately contains no number at all.
 * Those are reported as hints. A placeholder the translation *adds*, or any
 * difference outside a plural form, stays a mismatch.
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

    const omissionInPluralForm =
      unexpectedInTarget.length === 0 && (isPluralForm(key) || pluralBases.has(key));
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
 * Flags a leaf whose shape differs between source and target: a string in
 * one and a map or array in the other. Both sides being 'empty' (null) is
 * not a mismatch — that is a missing-value finding, not a shape problem.
 */
export function findStructureMismatches(sourceKeys: FlatMap, targetKeys: FlatMap): StructureMismatch[] {
  const mismatches: StructureMismatch[] = [];
  for (const key of Object.keys(sourceKeys)) {
    if (!(key in targetKeys)) continue;
    const sourceShape = shapeOf(sourceKeys[key]);
    const targetShape = shapeOf(targetKeys[key]);
    if (sourceShape === 'empty' || targetShape === 'empty') continue;
    if (sourceShape !== targetShape) {
      mismatches.push({ key, sourceShape, targetShape });
    }
  }
  return mismatches;
}

/**
 * gettext catalogues flatten plural forms to `key__plural_N` (see
 * po-utils.ts's PLURAL_PREFIX). Matched here rather than imported so this
 * module stays free of parser dependencies.
 */
const GETTEXT_PLURAL_SUFFIX = /__plural_\d+$/;

/** `count.one`, `count_one`, `count_plural` and `item__plural_2`. */
function isPluralForm(key: string): boolean {
  if (GETTEXT_PLURAL_SUFFIX.test(key)) return true;
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  return RAILS_PLURAL_LEAVES.has(leaf) || I18NEXT_PLURAL_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

/**
 * Base keys of gettext plural entries, e.g. `item` for `item__plural_1`. The
 * singular of a plural entry is compared against whichever form the target
 * language happens to put first, so it gets the same latitude as the other
 * forms.
 */
function gettextPluralBases(keys: string[]): Set<string> {
  const bases = new Set<string>();
  for (const key of keys) {
    if (GETTEXT_PLURAL_SUFFIX.test(key)) bases.add(key.replace(GETTEXT_PLURAL_SUFFIX, ''));
  }
  return bases;
}

const RAILS_PLURAL_LEAVES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const I18NEXT_PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other', '_plural'];

// A lone `status.other` with no sibling `status.one` etc. is not a real
// plural group (see translation-utils.ts's isPluralForm) — it only counts
// once at least two CLDR-category siblings share the same parent.
function pluralParentsOf(keys: string[]): Set<string> {
  const railsCandidates = new Map<string, Set<string>>();
  const i18nextParents = new Set<string>();

  for (const key of keys) {
    const lastDot = key.lastIndexOf('.');
    const leaf = lastDot === -1 ? key : key.slice(lastDot + 1);
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

/**
 * Flags a source key group that has plural sub-keys (Rails one/other, or
 * i18next _one/_plural suffixes) where the target has no plural forms at
 * all for that group, even though the target file does have *something*
 * under that key (otherwise it is a plain missing-key finding).
 */
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

/**
 * Two separate findings, deliberately not conflated: an empty target
 * string is a real gap, while a target that is byte-identical to the
 * source is only a hint — short words and proper nouns are legitimately
 * identical across languages, so this must never be reported as an error.
 */
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

/**
 * Rails plural groups (`key.one`, `key.other`) in the target that lack
 * categories the target language needs, e.g. Polish without `few`/`many`.
 * Rails then silently falls back to `other`, rendering fluent but wrong text.
 */
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
    if (!key.includes('.') || !RAILS_PLURAL_LEAVES.has(leafOf(key))) continue;
    const parent = parentOf(key);
    if (!groups.has(parent)) groups.set(parent, new Set());
    groups.get(parent)!.add(leafOf(key));
  }
  for (const [parent, leaves] of groups) {
    if (!leaves.has('other') || leaves.size < 2) groups.delete(parent);
  }
  return groups;
}

/**
 * Plural categories a locale uses for everyday counts, or null for an unknown
 * locale. CLDR gives es/fr/it/pt a `many` for 1,000,000 that rails-i18n does
 * not implement and no one writes, so only categories 0..1000 reach count.
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

/** A missing `sv` `few`: the source has it for Polish's sake, Swedish never uses it. */
export function isUnneededPluralLeaf(key: string, sourceKeys: FlatMap, locale: string): boolean {
  const leaf = leafOf(key);
  if (!key.includes('.') || !RAILS_PLURAL_LEAVES.has(leaf) || leaf === 'other') return false;
  if (!railsPluralGroups(sourceKeys).has(parentOf(key))) return false;
  const used = usedPluralCategories(locale);
  return used !== null && !used.includes(leaf);
}
