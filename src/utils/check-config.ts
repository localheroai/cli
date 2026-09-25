import path from 'path';
import { promises as fs } from 'fs';
import { glob } from 'glob';
import { parseFile, flattenTranslations } from './files.js';
import { findTargetFile } from './translation-utils.js';
import { detectProjectType, type ProjectDetectionResult } from './project-detection.js';
import {
  detectLocalesFromPaths,
  looksLikeGettextSource,
  chooseSourceLocale,
  type SourceReason
} from './locale-detection.js';
import type { TranslationConfig } from '../types/index.js';

const DEFAULT_PATTERN = '**/*.{json,yml,yaml,po,pot}';

export interface DetectedSetup {
  source: string;
  reason: SourceReason;
  paths: string[];
  pattern: string;
  excluded: string[];
}

export interface ConfigDetectionDeps {
  detectProjectType: () => Promise<ProjectDetectionResult>;
  listFiles: (paths: string[], pattern: string, ignore: string[]) => Promise<string[]>;
  readFile: (filePath: string) => Promise<string>;
}

export interface DetectionOptions {
  source?: string;
  locales?: string[];
  path?: string;
  pattern?: string;
}

export async function listTranslationFiles(paths: string[], pattern: string, ignore: string[]): Promise<string[]> {
  const found = await Promise.all(
    paths.map((dir) => glob(path.join(dir, pattern), { ignore, nodir: true, follow: true }))
  );
  return found.flat().sort();
}

export const defaultConfigDetectionDeps: ConfigDetectionDeps = {
  detectProjectType,
  listFiles: listTranslationFiles,
  readFile: (filePath) => fs.readFile(filePath, 'utf8')
};

async function countKeys(files: string[], readFile: ConfigDetectionDeps['readFile']): Promise<number> {
  let total = 0;
  for (const file of files) {
    try {
      const format = path.extname(file).slice(1);
      total += Object.keys(flattenTranslations(parseFile(await readFile(file), format, file), '', format)).length;
    } catch {
      continue;
    }
  }
  return total;
}

async function gettextSourceLocales(
  locales: Record<string, string[]>,
  readFile: ConfigDetectionDeps['readFile']
): Promise<string[]> {
  const sources: string[] = [];
  for (const [locale, files] of Object.entries(locales)) {
    const catalogs = files.filter((file) => path.extname(file) === '.po');
    if (catalogs.length === 0) continue;
    const contents = await Promise.all(catalogs.map(readFile));
    if (contents.every(looksLikeGettextSource)) sources.push(locale);
  }
  return sources;
}

// init's generic detection writes **/*.po, which would hide a .pot source template.
function withTemplates(pattern: string): string {
  if (pattern.includes('pot')) return pattern;
  if (pattern.endsWith('*.po')) return pattern.replace(/\*\.po$/, '*.{po,pot}');
  return pattern.replace(/\{([^}]*\bpo\b[^}]*)\}$/, '{$1,pot}');
}

// Vendored files (config/locales/rails-i18n/fr.yml) share no file with the
// source, so their languages are not targets unless --locales names them.
function hasCounterpart(
  targetFiles: string[],
  locale: string,
  sourceFiles: string[],
  sourceLocale: string
): boolean {
  const targets = targetFiles.map((file) => ({ path: file, locale, format: path.extname(file).slice(1) }));
  return sourceFiles.some((file) =>
    findTargetFile(targets, locale, { path: file, locale: sourceLocale, format: path.extname(file).slice(1) }, sourceLocale)
  );
}

// Ignore entries are joined onto the working directory later, so they must be relative.
function relativeDir(dir: string): string {
  const relative = path.isAbsolute(dir) ? path.relative(process.cwd(), dir) : dir;
  return relative.endsWith('/') ? relative : `${relative}/`;
}

async function scanScope(
  options: DetectionOptions,
  deps: ConfigDetectionDeps
): Promise<{ paths: string[]; pattern: string; ignore: string[] }> {
  if (options.path) {
    return { paths: [relativeDir(options.path)], pattern: options.pattern ?? DEFAULT_PATTERN, ignore: [] };
  }
  const { defaults } = await deps.detectProjectType();
  return {
    paths: [defaults.translationPath],
    pattern: options.pattern ?? withTemplates(defaults.filePattern),
    ignore: defaults.ignorePaths ?? []
  };
}

export async function detectCheckConfig(
  options: DetectionOptions,
  deps: ConfigDetectionDeps = defaultConfigDetectionDeps
): Promise<{ config: TranslationConfig; detected: DetectedSetup } | null> {
  const { paths, pattern, ignore: scopeIgnore } = await scanScope(options, deps);
  const { locales, templates, unrecognized } = detectLocalesFromPaths(await deps.listFiles(paths, pattern, scopeIgnore));
  const localeCodes = Object.keys(locales);
  const hasTemplate = templates.length > 0;

  const gettextSources = options.source ? [] : await gettextSourceLocales(locales, deps.readFile);
  const needsKeyCounts = !options.source && gettextSources.length !== 1 && !hasTemplate && !localeCodes.includes('en');
  const keyCounts: Record<string, number> = {};
  if (needsKeyCounts) {
    for (const [locale, files] of Object.entries(locales)) keyCounts[locale] = await countKeys(files, deps.readFile);
  }

  const choice = chooseSourceLocale({ explicit: options.source, locales: localeCodes, keyCounts, gettextSources, hasTemplate });
  if (!choice) return null;

  const ignore = [...scopeIgnore, ...unrecognized];
  // A source catalog and a .pot describe the same strings; comparing against both doubles every finding.
  if (hasTemplate && locales[choice.locale]) ignore.push(...templates);

  const candidates = localeCodes.filter((locale) => locale !== choice.locale);
  const sourceFiles = locales[choice.locale] ?? [];
  const matching = sourceFiles.length > 0
    ? candidates.filter((locale) => hasCounterpart(locales[locale], locale, sourceFiles, choice.locale))
    : candidates;
  const outputLocales = options.locales?.length ? options.locales : matching;
  const excluded = options.locales?.length ? [] : candidates.filter((locale) => !matching.includes(locale));

  return {
    config: { sourceLocale: choice.locale, outputLocales, translationFiles: { paths, pattern, ignore } },
    detected: { source: choice.locale, reason: choice.reason, paths, pattern, excluded }
  };
}
