import { valuesEqual } from './git-changes.js';
import { PLURAL_SUFFIX_REGEX } from './po-utils.js';
import { dedupeYaml } from './yaml-duplicates.js';
import { readFileAtRef, relativeToCwd, renamesSince, type GitRunner } from './check-git.js';
import type { FlatMap } from './check-utils.js';
import type { TranslationFile } from '../types/index.js';

const RAILS_PLURAL_LEAF = /\.(zero|one|two|few|many|other)$/;
const I18NEXT_PLURAL_SUFFIX = /_(zero|one|two|few|many|other|plural)$/;

export function changedKeys(before: FlatMap, after: FlatMap): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before) || !valuesEqual(before[key], value)) changed.add(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) changed.add(key);
  }
  return changed;
}

function pluralBase(key: string): string {
  return key.replace(PLURAL_SUFFIX_REGEX, '').replace(RAILS_PLURAL_LEAF, '').replace(I18NEXT_PLURAL_SUFFIX, '');
}

function ancestorsOf(key: string): string[] {
  const ancestors: string[] = [];
  for (let end = key.lastIndexOf('.'); end > 0; end = key.lastIndexOf('.', end - 1)) {
    ancestors.push(key.slice(0, end));
  }
  return ancestors;
}

/**
 * A finding belongs to a change when its key changed, when it sits on a parent of a changed key
 * (a plural group, a string that became a map) or when it is another plural form of a changed key.
 */
export function createChangeMatcher(changed: Set<string>): (key: string) => boolean {
  const ancestors = new Set<string>();
  const bases = new Set<string>();
  for (const key of changed) {
    for (const ancestor of ancestorsOf(key)) ancestors.add(ancestor);
    bases.add(pluralBase(key));
  }
  return (key) => changed.has(key) || ancestors.has(key) || bases.has(pluralBase(key));
}

type KeyReader = (file: TranslationFile) => FlatMap;

/** An unparsable base version reads as empty, so every key in the file counts as changed. */
function keysAtRef(git: GitRunner, ref: string, basePath: string, file: TranslationFile, read: KeyReader): FlatMap {
  const raw = readFileAtRef(git, ref, basePath);
  if (raw === null) return {};
  const at = (text: string): TranslationFile => ({ ...file, content: Buffer.from(text).toString('base64') });
  try {
    return read(at(raw));
  } catch {
    if (file.format !== 'yml' && file.format !== 'yaml') return {};
  }
  try {
    return read(at(dedupeYaml(raw)));
  } catch {
    return {};
  }
}

export interface KeyChanges {
  base: string;
  inSource: (path: string, key: string) => boolean;
  inTarget: (locale: string, path: string, key: string) => boolean;
}

export interface ChangeInputs {
  sources: { file: TranslationFile; keys: FlatMap }[];
  /** Multi-language files share a path across locales, so targets are told apart by locale too. */
  targets: { locale: string; file: TranslationFile; keys: FlatMap }[];
  readSource: KeyReader;
  readTarget: KeyReader;
}

/**
 * Diffs each file against its version at `base.ref`, read with the same key reader as the check itself
 * so the changed keys use the check's key names. Throws when git fails.
 */
export function diffAgainstBase(git: GitRunner, base: { ref: string; label: string }, inputs: ChangeInputs): KeyChanges {
  const source = new Map<string, (key: string) => boolean>();
  const target = new Map<string, (key: string) => boolean>();
  const targetId = (locale: string, path: string) => `${locale}\0${path}`;
  // A moved file keeps its keys; read from the new path it would look entirely new.
  const renames = renamesSince(git, base.ref);
  const before = (file: TranslationFile, read: KeyReader) =>
    keysAtRef(git, base.ref, renames.get(relativeToCwd(file.path)) ?? file.path, file, read);
  for (const { file, keys } of inputs.sources) {
    source.set(file.path, createChangeMatcher(changedKeys(before(file, inputs.readSource), keys)));
  }
  for (const { locale, file, keys } of inputs.targets) {
    target.set(targetId(locale, file.path), createChangeMatcher(changedKeys(before(file, inputs.readTarget), keys)));
  }
  return {
    base: base.label,
    inSource: (path, key) => source.get(path)?.(key) ?? false,
    inTarget: (locale, path, key) => target.get(targetId(locale, path))?.(key) ?? false
  };
}
