import { parseFile } from './files.js';
import { dedupeYaml, findDuplicateYamlKeys } from './yaml-duplicates.js';
import { readFileAtRef, relativeToCwd, renamesSince, type GitRunner } from './check-git.js';
import type { TranslationFile } from '../types/index.js';

/** The base a changed-only run compared with, or why it could not; null for a full check. */
export type ChangeStatus = { base: string } | { error: string } | null;

export const DUPLICATE_KEY_ERROR = 'Map keys must be unique';

export interface FileSet {
  sourceFiles: TranslationFile[];
  targetFilesByLocale: Record<string, TranslationFile[]>;
  /** Repeated YAML keys in files that only parse once deduplicated. */
  duplicates: { locale: string; path: string; key: string; values: string[] }[];
}

function isYaml(format: string): boolean {
  return format === 'yml' || format === 'yaml';
}

/**
 * The same files as they were at `ref`, under their current paths so findings on both sides compare.
 * A moved file is read from its old path. A file the base lacks, or cannot parse, is left out.
 * `deletedTargets` are target files the change removed; they exist only at the base.
 * Throws when git fails.
 */
export function baseFileSet(git: GitRunner, ref: string, current: FileSet, deletedTargets: TranslationFile[]): FileSet {
  const renames = renamesSince(git, ref);
  const rawByPath = new Map<string, string | null>();
  const duplicates: FileSet['duplicates'] = [];

  const readRaw = (path: string): string | null => {
    if (!rawByPath.has(path)) rawByPath.set(path, readFileAtRef(git, ref, renames.get(relativeToCwd(path)) ?? path));
    return rawByPath.get(path) ?? null;
  };

  const atBase = (file: TranslationFile): TranslationFile | null => {
    const raw = readRaw(file.path);
    if (raw === null) return null;
    const version = (text: string): TranslationFile => ({ ...file, content: Buffer.from(text).toString('base64') });
    try {
      parseFile(raw, file.format, file.path);
      return version(raw);
    } catch (error) {
      if (!isYaml(file.format) || !String(error).includes(DUPLICATE_KEY_ERROR)) return null;
    }
    for (const duplicate of findDuplicateYamlKeys(raw, file.locale)) {
      duplicates.push({ locale: file.locale, path: file.path, ...duplicate });
    }
    return version(dedupeYaml(raw));
  };
  const present = (files: TranslationFile[]) => files.map(atBase).filter((file): file is TranslationFile => file !== null);

  const targetFilesByLocale: FileSet['targetFilesByLocale'] = {};
  for (const [locale, files] of Object.entries(current.targetFilesByLocale)) {
    targetFilesByLocale[locale] = present([...files, ...deletedTargets.filter((file) => file.locale === locale)]);
  }
  return { sourceFiles: present(current.sourceFiles), targetFilesByLocale, duplicates };
}
