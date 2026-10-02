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
  type DetectedLocales,
  type SourceChoice,
  type SourceReason
} from './locale-detection.js';
import type { TranslationConfig } from '../types/index.js';

const DEFAULT_PATTERN = '**/*.{json,yml,yaml,po,pot}';
const LOCALE_DIR_PATTERNS = ['**/{locales,locale,translations,i18n,lang,langs,messages}/', '**/priv/gettext/'];
const MAX_LOCALE_DIR_DEPTH = 6;
// Build output, dependencies and test data hold locale folders that are not the app's own.
const NOT_APP_DIRS = [
  'node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'coverage', 'tmp', '.claude',
  '.venv', 'venv', 'site-packages', 'test', 'tests', 'spec', '__tests__', 'fixtures', 'examples'
];

export interface DetectedSetup {
  source: string;
  reason: SourceReason;
  paths: string[];
  pattern: string;
  excluded: string[];
  otherPaths: string[];
}

export interface ConfigDetectionDeps {
  detectProjectType: () => Promise<ProjectDetectionResult>;
  listFiles: (paths: string[], pattern: string, ignore: string[]) => Promise<string[]>;
  readFile: (filePath: string) => Promise<string>;
  findLocaleDirs: () => Promise<string[]>;
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

export async function findLocaleDirs(root = process.cwd()): Promise<string[]> {
  const dirs = await glob(LOCALE_DIR_PATTERNS, {
    cwd: root,
    maxDepth: MAX_LOCALE_DIR_DEPTH,
    ignore: NOT_APP_DIRS.map((dir) => `**/${dir}/**`)
  });
  return dirs.map(relativeDir).sort();
}

export const defaultConfigDetectionDeps: ConfigDetectionDeps = {
  detectProjectType,
  listFiles: listTranslationFiles,
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  findLocaleDirs: () => findLocaleDirs()
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

interface ScanScope {
  paths: string[];
  pattern: string;
  ignore: string[];
}

async function scanScope(options: DetectionOptions, deps: ConfigDetectionDeps): Promise<ScanScope> {
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

async function scan(scope: ScanScope, deps: ConfigDetectionDeps): Promise<DetectedLocales> {
  return detectLocalesFromPaths(await deps.listFiles(scope.paths, scope.pattern, scope.ignore));
}

async function sourceOf(found: DetectedLocales, options: DetectionOptions, deps: ConfigDetectionDeps): Promise<SourceChoice | null> {
  const localeCodes = Object.keys(found.locales);
  const hasTemplate = found.templates.length > 0;
  const gettextSources = options.source ? [] : await gettextSourceLocales(found.locales, deps.readFile);
  const needsKeyCounts = !options.source && gettextSources.length !== 1 && !hasTemplate && !localeCodes.includes('en');
  const keyCounts: Record<string, number> = {};
  if (needsKeyCounts) {
    for (const [locale, files] of Object.entries(found.locales)) keyCounts[locale] = await countKeys(files, deps.readFile);
  }
  return chooseSourceLocale({ explicit: options.source, locales: localeCodes, keyCounts, gettextSources, hasTemplate });
}

function holdsTranslations(found: DetectedLocales): boolean {
  const localeCount = Object.keys(found.locales).length;
  return localeCount >= 2 || (found.templates.length > 0 && localeCount >= 1);
}

// Monorepos keep locales in packages/<app>/locales or apps/<app>/public/locales, below any
// folder a project type names. Apps do not share keys, so one folder is checked and the
// others are named: comparing them as one would pair one app's files with another's.
async function nestedScope(
  options: DetectionOptions,
  deps: ConfigDetectionDeps
): Promise<{ scope: ScanScope; found: DetectedLocales; otherPaths: string[] } | null> {
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const folders: { dir: string; found: DetectedLocales }[] = [];
  for (const dir of await deps.findLocaleDirs()) {
    const found = await scan({ paths: [dir], pattern, ignore: [] }, deps);
    if (holdsTranslations(found)) folders.push({ dir, found });
  }
  const outermost = folders.filter((folder) => !folders.some((other) => other !== folder && folder.dir.startsWith(other.dir)));
  if (outermost.length === 0) return null;

  const localeCount = (folder: { found: DetectedLocales }) => Object.keys(folder.found.locales).length;
  const [chosen] = [...outermost].sort((a, b) => localeCount(b) - localeCount(a));
  return {
    scope: { paths: [chosen.dir], pattern, ignore: [] },
    found: chosen.found,
    otherPaths: outermost.filter((folder) => folder !== chosen).map((folder) => folder.dir)
  };
}

export async function detectCheckConfig(
  options: DetectionOptions,
  deps: ConfigDetectionDeps = defaultConfigDetectionDeps
): Promise<{ config: TranslationConfig; detected: DetectedSetup } | null> {
  let scope = await scanScope(options, deps);
  let found = await scan(scope, deps);
  let otherPaths: string[] = [];
  const foundNothing = Object.keys(found.locales).length === 0 && found.templates.length === 0;
  const nested = !options.path && foundNothing ? await nestedScope(options, deps) : null;
  if (nested) ({ scope, found, otherPaths } = nested);
  const choice = await sourceOf(found, options, deps);
  if (!choice) return null;

  const { locales, templates, unrecognized } = found;
  const { paths, pattern } = scope;
  const ignore = [...scope.ignore, ...unrecognized];
  // A source catalog and a .pot describe the same strings; comparing against both doubles every finding.
  if (templates.length > 0 && locales[choice.locale]) ignore.push(...templates);

  const candidates = Object.keys(locales).filter((locale) => locale !== choice.locale);
  const sourceFiles = locales[choice.locale] ?? [];
  const matching = sourceFiles.length > 0
    ? candidates.filter((locale) => hasCounterpart(locales[locale], locale, sourceFiles, choice.locale))
    : candidates;
  const outputLocales = options.locales?.length ? options.locales : matching;
  const excluded = options.locales?.length ? [] : candidates.filter((locale) => !matching.includes(locale));

  return {
    config: { sourceLocale: choice.locale, outputLocales, translationFiles: { paths, pattern, ignore } },
    detected: { source: choice.locale, reason: choice.reason, paths, pattern, excluded, otherPaths }
  };
}
