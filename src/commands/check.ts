import chalk from 'chalk';
import { appendFileSync } from 'fs';
import { configService, type ConfigService } from '../utils/config.js';
import { findTranslationFiles, parseFile, flattenTranslations, extractLocaleFromPath } from '../utils/files.js';
import { findDuplicateYamlKeys, dedupeYaml } from '../utils/yaml-duplicates.js';
import {
  findMissingTranslationsByLocale,
  findTargetFile,
  processTargetContent
} from '../utils/translation-utils.js';
import { createIgnoreMatcher, filterKeys } from '../utils/ignore-keys.js';
import {
  detectCheckConfig,
  defaultConfigDetectionDeps,
  type ConfigDetectionDeps,
  type DetectedSetup
} from '../utils/check-config.js';
import {
  findOrphanKeys,
  findPlaceholderMismatches,
  findStructureMismatches,
  findPluralShapeMismatches,
  findPluralizedFlatKeys,
  findMissingPluralCategories,
  usedPluralCategories,
  findEmptyAndIdentical,
  findConflictingKeys,
  toStringValue,
  type FlatMap,
  type OrphanFinding,
  type PlaceholderMismatch,
  type StructureMismatch,
  type PluralShapeMismatch,
  type MissingPluralCategories,
  type EmptyFinding,
  type IdenticalFinding,
  type ConflictingKey
} from '../utils/check-utils.js';
import { detectCiContext, type CiContext, type Env } from '../utils/ci-context.js';
import { resolveChangeBase, runGit, type GitRunner } from '../utils/check-git.js';
import { diffAgainstBase, type ChangeInputs, type ChangeStatus, type KeyChanges } from '../utils/check-changes.js';
import { buildStepSummary, plural, type ProblemCounts } from '../utils/check-summary.js';
import { spellPlaceholders } from '../utils/placeholders.js';
import { keyLineFinder, type KeyLineLookup } from '../utils/key-lines.js';
import type {
  TranslationConfig,
  TranslationFile,
  TranslationFileOptions,
  TranslationFilesResult
} from '../types/index.js';

const FAIL_ON_MODES = ['missing', 'placeholders', 'any', 'none'] as const;
const FORMATS = ['github', 'text'] as const;

export type FailOn = (typeof FAIL_ON_MODES)[number];
type OutputFormat = (typeof FORMATS)[number] | 'json';

export interface CheckOptions {
  source?: string;
  locales?: string;
  json?: boolean;
  all?: boolean;
  failOn?: FailOn;
  format?: (typeof FORMATS)[number];
  path?: string;
  pattern?: string;
  changedOnly?: boolean;
  full?: boolean;
}

interface CheckDependencies {
  console: {
    log: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
  };
  configUtils: Pick<ConfigService, 'getProjectConfig'>;
  fileUtils: {
    findTranslationFiles: (
      config: TranslationConfig,
      options?: TranslationFileOptions
    ) => Promise<TranslationFile[] | TranslationFilesResult>;
  };
  projectDetection: Pick<ConfigDetectionDeps, 'detectProjectType'>;
  fsUtils: Pick<ConfigDetectionDeps, 'listFiles' | 'readFile'>;
  env: Env;
  git: GitRunner;
  appendFile: (path: string, text: string) => void;
}

const defaultDeps: CheckDependencies = {
  console,
  configUtils: configService,
  fileUtils: { findTranslationFiles },
  projectDetection: { detectProjectType: defaultConfigDetectionDeps.detectProjectType },
  fsUtils: { listFiles: defaultConfigDetectionDeps.listFiles, readFile: defaultConfigDetectionDeps.readFile },
  env: process.env,
  git: runGit,
  appendFile: (path, text) => appendFileSync(path, text)
};

/** Set on each finding in changed-only mode: whether a key the change touched caused it. */
interface Introduced {
  introduced?: boolean;
}

type Located<T> = T & { path: string } & Introduced;

interface LocaleReport {
  locale: string;
  files: string[];
  keyCount: number;
  missing: Located<{ key: string; targetPath: string }>[];
  empty: Located<EmptyFinding>[];
  identical: Located<IdenticalFinding>[];
  placeholderMismatches: Located<PlaceholderMismatch>[];
  placeholderHints: Located<PlaceholderMismatch>[];
  orphans: Located<OrphanFinding>[];
  structureMismatches: Located<StructureMismatch>[];
  pluralShapeMismatches: Located<PluralShapeMismatch>[];
  missingPluralCategories: Located<MissingPluralCategories>[];
  conflictingKeys: (ConflictingKey & Introduced)[];
  duplicateKeys: Located<{ key: string; values: string[] }>[];
  /** Source files this locale has no file for; only reported without a localhero.json. */
  missingFiles: string[];
}

const DUPLICATE_KEY_ERROR = 'Map keys must be unique';

interface RecoveredFiles {
  files: TranslationFile[];
  duplicates: { locale: string; key: string; path: string; values: string[] }[];
}

// The CLI's YAML parser rejects a repeated key that Rails accepts (last value
// wins), so such files are reparsed here and the repeat becomes a finding.
async function recoverDuplicateKeyFiles(
  failures: TranslationFilesResult['parseFailures'],
  knownLocales: string[],
  config: TranslationConfig,
  readFile: CheckDependencies['fsUtils']['readFile']
): Promise<RecoveredFiles> {
  const recovered: RecoveredFiles = { files: [], duplicates: [] };
  for (const failure of failures) {
    const format = failure.path.split('.').pop() ?? '';
    if (!['yml', 'yaml'].includes(format) || !String(failure.error).includes(DUPLICATE_KEY_ERROR)) continue;
    let locale: string;
    try {
      locale = extractLocaleFromPath(failure.path, config.translationFiles.localeRegex, knownLocales);
    } catch {
      continue;
    }
    const raw = await readFile(failure.path);
    recovered.files.push({ path: failure.path, format, locale, content: Buffer.from(dedupeYaml(raw)).toString('base64') });
    for (const duplicate of findDuplicateYamlKeys(raw, locale)) {
      recovered.duplicates.push({ locale, path: failure.path, ...duplicate });
    }
  }
  return recovered;
}

function decode(file: TranslationFile, sourceLocale: string): Record<string, any> {
  if (!file.content) return {};
  const raw = Buffer.from(file.content, 'base64').toString('utf8');
  return parseFile(raw, file.format, file.path, { sourceLanguage: sourceLocale, currentLanguage: file.locale });
}

function sourceKeysFor(sourceFile: TranslationFile, sourceLocale: string): FlatMap {
  const parsed = decode(sourceFile, sourceLocale);
  const wrapper = parsed[sourceLocale];
  const tree = wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) ? wrapper : parsed;
  return flattenTranslations(tree, '', sourceFile.format);
}

function isYaml(file: TranslationFile): boolean {
  return file.format === 'yml' || file.format === 'yaml';
}

function targetKeysFor(
  targetFiles: TranslationFile[],
  targetLocale: string,
  sourceFile: TranslationFile,
  sourceLocale: string
): { keys: FlatMap; path: string } {
  const targetFile = findTargetFile(targetFiles, targetLocale, sourceFile, sourceLocale);
  if (!targetFile) return { keys: {}, path: '' };
  return { keys: keysOf(targetFile, targetLocale, sourceLocale), path: targetFile.path };
}

function keysOf(targetFile: TranslationFile, targetLocale: string, sourceLocale: string): FlatMap {
  return processTargetContent(decode(targetFile, sourceLocale), targetLocale, targetFile.format);
}

interface CheckResult {
  aborted: boolean;
  exitCode: number;
  reports: LocaleReport[];
  sourceLocale: string;
  sourceFiles: string[];
  keyCount: number;
  parseFailures: TranslationFilesResult['parseFailures'];
  detected: DetectedSetup | null;
  format: OutputFormat;
  changes: ChangeStatus;
  /** Raw text of each loaded file by path, for annotation line numbers. */
  fileContents: Record<string, string>;
}

function failedResult(format: OutputFormat, sourceLocale = ''): CheckResult {
  return {
    aborted: true,
    exitCode: 1,
    reports: [],
    sourceLocale,
    sourceFiles: [],
    keyCount: 0,
    parseFailures: [],
    detected: null,
    format,
    changes: null,
    fileContents: {}
  };
}

const SOURCE_REASONS: Record<DetectedSetup['reason'], string> = {
  option: 'from --source',
  gettext: 'its catalog is untranslated',
  template: 'from the .pot template',
  en: 'en is present',
  guessed: 'guessed from the most keys'
};

function printDetected(con: CheckDependencies['console'], detected: DetectedSetup, targetCount: number): void {
  const where = detected.paths.map((dir) => `${dir}${detected.pattern}`).join(', ');
  if (targetCount === 0) {
    con.log(chalk.blue(`ℹ No localhero.json found. Only ${detected.source} found in ${where}, so there is nothing to compare.`));
    return;
  }
  con.log(chalk.blue(`ℹ No localhero.json found. Checking ${where}, source ${detected.source} (${SOURCE_REASONS[detected.reason]}).`));
  if (detected.excluded.length > 0) {
    con.log(chalk.blue(`ℹ Skipped ${detected.excluded.join(', ')}: no file matches a source file. Include them with --locales.`));
  }
  if (detected.reason === 'guessed') {
    con.log(chalk.yellow(`⚠ ${detected.source} is a guess. If your source language is another one, pass --source <locale>.`));
  }
}

function parseLocales(value: string | undefined): string[] {
  return value ? value.split(',').map((l) => l.trim()).filter(Boolean) : [];
}

function invalidOption(options: CheckOptions): string | null {
  if (options.failOn && !(FAIL_ON_MODES as readonly string[]).includes(options.failOn)) {
    return `Invalid --fail-on "${options.failOn}". Use one of: ${FAIL_ON_MODES.join(', ')}.`;
  }
  if (options.format && !(FORMATS as readonly string[]).includes(options.format)) {
    return `Invalid --format "${options.format}". Use one of: ${FORMATS.join(', ')}.`;
  }
  if (options.changedOnly && options.full) {
    return 'Use either --changed-only or --full, not both.';
  }
  return null;
}

function outputFormat(options: CheckOptions, ci: CiContext): OutputFormat {
  if (options.json) return 'json';
  if (options.format) return options.format;
  return ci.githubActions ? 'github' : 'text';
}

const SILENT = { log: () => {} };

/** A target file the change deleted still needs comparing, so its keys count as removed. */
function targetsToCompare(
  locale: string,
  files: TranslationFile[],
  missing: { locale: string; targetPath: string }[],
  read: (file: TranslationFile) => FlatMap
): ChangeInputs['targets'] {
  const paths = new Set(files.map((f) => f.path));
  const deleted = new Set(missing.filter((m) => m.locale === locale && !paths.has(m.targetPath)).map((m) => m.targetPath));
  return [
    ...files.map((file) => ({ locale, file, keys: read(file) })),
    ...[...deleted].map((path) => ({ locale, file: { path, format: formatOf(path), locale }, keys: {} }))
  ];
}

function compareWithBase(
  deps: CheckDependencies,
  ci: CiContext,
  config: TranslationConfig,
  inputs: ChangeInputs
): { status: ChangeStatus; changes: KeyChanges | null } {
  const configured = config.translationFiles.baseBranch || deps.env.GITHUB_BASE_REF;
  const base = resolveChangeBase(deps.git, {
    pullRequest: ci.pullRequest,
    baseBranches: configured ? [configured] : ['main', 'master']
  });
  if ('error' in base) return { status: base, changes: null };
  try {
    const changes = diffAgainstBase(deps.git, base, inputs);
    return { status: { base: changes.base }, changes };
  } catch (error) {
    return { status: { error: `git could not read the base version: ${(error as Error).message.trim()}` }, changes: null };
  }
}

function tagIntroduced(report: LocaleReport, changes: KeyChanges, pairedSources: Map<string, string[]>, allSources: string[]): void {
  const { locale } = report;
  const introducedIn = (key: string, targetPaths: string[], sourcePaths: string[]): boolean =>
    targetPaths.some((path) => changes.inTarget(locale, path, key)) || sourcePaths.some((path) => changes.inSource(path, key));
  const inTarget = <T extends { key: string; path: string }>(findings: T[], sources?: string[]): (T & Introduced)[] =>
    findings.map((f) => ({ ...f, introduced: introducedIn(f.key, [f.path], sources ?? pairedSources.get(f.path) ?? allSources) }));

  report.missing = report.missing.map((f) => ({ ...f, introduced: introducedIn(f.key, [f.targetPath], [f.path]) }));
  report.empty = inTarget(report.empty);
  report.identical = inTarget(report.identical);
  report.placeholderMismatches = inTarget(report.placeholderMismatches);
  report.placeholderHints = inTarget(report.placeholderHints);
  report.structureMismatches = inTarget(report.structureMismatches);
  report.pluralShapeMismatches = inTarget(report.pluralShapeMismatches);
  report.missingPluralCategories = inTarget(report.missingPluralCategories);
  report.duplicateKeys = inTarget(report.duplicateKeys);
  report.orphans = inTarget(report.orphans, allSources);
  report.conflictingKeys = report.conflictingKeys.map((f) => ({ ...f, introduced: introducedIn(f.key, f.files, allSources) }));
}

function filterFindings(r: LocaleReport, keep: (finding: Introduced) => boolean): LocaleReport {
  return {
    ...r,
    missing: r.missing.filter(keep),
    empty: r.empty.filter(keep),
    identical: r.identical.filter(keep),
    placeholderMismatches: r.placeholderMismatches.filter(keep),
    placeholderHints: r.placeholderHints.filter(keep),
    orphans: r.orphans.filter(keep),
    structureMismatches: r.structureMismatches.filter(keep),
    pluralShapeMismatches: r.pluralShapeMismatches.filter(keep),
    missingPluralCategories: r.missingPluralCategories.filter(keep),
    conflictingKeys: r.conflictingKeys.filter(keep),
    duplicateKeys: r.duplicateKeys.filter(keep)
  };
}

function isIntroduced(finding: Introduced): boolean {
  return finding.introduced !== false;
}

function isExisting(finding: Introduced): boolean {
  return finding.introduced === false;
}

function formatOf(path: string): string {
  return path.split('.').pop() ?? '';
}

function withPath<T>(findings: T[], path: string): (T & { path: string })[] {
  return findings.map((finding) => ({ ...finding, path }));
}

function missingCount(report: LocaleReport): number {
  return report.missing.length + report.empty.length;
}

function isAtOrUnder(key: string, parents: Set<string>): boolean {
  for (let end = key.length; end !== -1; end = key.lastIndexOf('.', end - 1)) {
    if (parents.has(key.slice(0, end))) return true;
  }
  return false;
}

function reshapedKeysBetween(sourceKeys: FlatMap, targetKeys: FlatMap): string[] {
  return [
    ...findStructureMismatches(sourceKeys, targetKeys).map((f) => f.key),
    ...findPluralShapeMismatches(sourceKeys, targetKeys).map((f) => f.key),
    ...findPluralizedFlatKeys(sourceKeys, targetKeys)
  ];
}

export async function runCheck(
  options: CheckOptions = {},
  deps: CheckDependencies = defaultDeps
): Promise<CheckResult> {
  const { console, configUtils, fileUtils, projectDetection, fsUtils } = deps;
  const ci = detectCiContext(deps.env);
  const format = outputFormat(options, ci);

  const optionError = invalidOption(options);
  if (optionError) {
    console.error(chalk.red(`\n✖ ${optionError}\n`));
    return failedResult(format);
  }

  const requestedLocales = parseLocales(options.locales);
  let config: TranslationConfig | null = await configUtils.getProjectConfig();
  let detected: DetectedSetup | null = null;
  if (!config) {
    const detection = await detectCheckConfig(
      { source: options.source, locales: requestedLocales, path: options.path, pattern: options.pattern },
      { ...projectDetection, ...fsUtils }
    );
    if (!detection) {
      console.error(chalk.red('\n✖ No translation files found. Run check from your project root, or point it at your locale folder with --path <dir>.\n'));
      return failedResult(format);
    }
    ({ config, detected } = detection);
  }
  if (!config.translationFiles?.paths) {
    console.error(chalk.red('\n✖ Invalid configuration: missing translationFiles.paths. Please run `npx @localheroai/cli init` to set up your configuration.\n'));
    return failedResult(format);
  }

  const sourceLocale = options.source || config.sourceLocale;
  const targetLocales = options.locales ? requestedLocales : config.outputLocales || [];

  const result = await fileUtils.findTranslationFiles(config, {
    returnFullResult: true,
    sourceLocale,
    targetLocales,
    ...(format === 'json' ? { logger: { log: console.error } } : {}),
    ...(format === 'github' ? { logger: SILENT } : {})
  });
  const discovered = result as TranslationFilesResult;
  const recovered = await recoverDuplicateKeyFiles(
    discovered.parseFailures ?? [],
    [sourceLocale, ...targetLocales],
    config,
    fsUtils.readFile
  );
  const recoveredPaths = new Set(recovered.files.map((f) => f.path));
  const parseFailures = (discovered.parseFailures ?? []).filter((f) => !recoveredPaths.has(f.path));
  const allFiles = [...discovered.allFiles, ...recovered.files];
  const sourceFiles = [...discovered.sourceFiles, ...recovered.files.filter((f) => f.locale === sourceLocale)];
  const targetFilesByLocale: Record<string, TranslationFile[]> = { ...discovered.targetFilesByLocale };
  for (const file of recovered.files.filter((f) => f.locale !== sourceLocale)) {
    targetFilesByLocale[file.locale] = [...(targetFilesByLocale[file.locale] ?? []), file];
  }
  const filesFor = (locale: string) => (targetFilesByLocale[locale] || []).map((f) => f.path);

  if (format === 'text') {
    if (detected) printDetected(console, detected, targetLocales.length);
    console.log(chalk.blue(`ℹ Source locale: ${sourceLocale} (${sourceFiles.map((f) => f.path).join(', ') || 'no source files found'})`));
    if (targetLocales.length === 0 && !detected) console.log(chalk.blue('ℹ Target locales: none configured'));
    for (const locale of targetLocales) {
      console.log(chalk.blue(`ℹ ${locale}: ${filesFor(locale).join(', ') || 'no files found'}`));
    }
  }

  if (parseFailures.length > 0 && format !== 'json') {
    console.error(chalk.red(`\n✖ ${parseFailures.length} translation file(s) could not be parsed and were skipped:`));
    for (const failure of parseFailures) {
      console.error(chalk.red(`  - ${failure.path}: ${failure.error}`));
    }
  }

  if (!allFiles || allFiles.length === 0) {
    console.error(chalk.red('\n✖ No translation files found in the specified paths.\n'));
    return failedResult(format, sourceLocale);
  }

  const ignoreMatcher = createIgnoreMatcher(config.translationFiles?.ignoreKeys ?? []);
  const withoutIgnored = (keys: FlatMap): FlatMap => filterKeys(keys, ignoreMatcher).kept;
  const localePluralCategories: Record<string, string[]> = {};
  for (const locale of targetLocales) {
    const categories = usedPluralCategories(locale);
    if (categories) localePluralCategories[locale] = categories;
  }

  const { missing } = findMissingTranslationsByLocale(
    sourceFiles,
    targetFilesByLocale,
    { sourceLocale, outputLocales: targetLocales, localePluralCategories },
    false,
    console,
    { ignoreMatcher }
  );

  const readSource = (file: TranslationFile): FlatMap => withoutIgnored(sourceKeysFor(file, sourceLocale));
  const sourceKeyMaps = sourceFiles.map((file) => ({ file, keys: readSource(file) }));
  const totalSourceKeys = new Set<string>();
  for (const { keys } of sourceKeyMaps) {
    for (const [key, value] of Object.entries(keys)) {
      const text = toStringValue(value);
      if (Array.isArray(value) || (text !== null && text !== '')) totalSourceKeys.add(key);
    }
  }
  const allSourceKeys: FlatMap = Object.assign({}, ...sourceKeyMaps.map(({ keys }) => keys));

  const readTarget = (file: TranslationFile): FlatMap => withoutIgnored(keysOf(file, file.locale, sourceLocale));
  const changedOnly = !options.full && (options.changedOnly || ci.pullRequest !== null);
  const { status: changeStatus, changes: keyChanges } = changedOnly
    ? compareWithBase(deps, ci, config, {
      sources: sourceKeyMaps,
      targets: targetLocales.flatMap((locale) =>
        targetsToCompare(locale, targetFilesByLocale[locale] || [], Object.values(missing), readTarget)
      ),
      readSource,
      readTarget
    })
    : { status: null, changes: null };
  const sourcePaths = sourceKeyMaps.map(({ file }) => file.path);

  const reports: LocaleReport[] = targetLocales.map((locale) => {
    const reshapedKeys = new Set<string>();
    const report: LocaleReport = {
      locale,
      files: filesFor(locale),
      keyCount: totalSourceKeys.size,
      missing: [],
      empty: [],
      identical: [],
      placeholderMismatches: [],
      placeholderHints: [],
      missingPluralCategories: [],
      orphans: [],
      structureMismatches: [],
      pluralShapeMismatches: [],
      conflictingKeys: [],
      duplicateKeys: recovered.duplicates
        .filter((d) => d.locale === locale)
        .map(({ key, path, values }) => ({ key, path, values })),
      missingFiles: []
    };

    const targetFiles = targetFilesByLocale[locale] || [];
    const pairedTargetKeys = new Map<string, FlatMap>();
    const pairedSources = new Map<string, string[]>();
    for (const { file: sourceFile, keys: sourceKeys } of sourceKeyMaps) {
      const { keys: allTargetKeys, path: targetPath } = targetKeysFor(targetFiles, locale, sourceFile, sourceLocale);
      const targetKeys = withoutIgnored(allTargetKeys);

      const { empty, identical } = findEmptyAndIdentical(sourceKeys, targetKeys);
      report.empty.push(...withPath(empty, targetPath));
      report.identical.push(...withPath(identical, targetPath));
      for (const finding of withPath(findPlaceholderMismatches(sourceKeys, targetKeys), targetPath)) {
        (finding.hint ? report.placeholderHints : report.placeholderMismatches).push(finding);
      }
      const structureMismatches = findStructureMismatches(sourceKeys, targetKeys);
      const pluralShapeMismatches = findPluralShapeMismatches(sourceKeys, targetKeys);
      report.structureMismatches.push(...withPath(structureMismatches, targetPath));
      report.pluralShapeMismatches.push(...withPath(pluralShapeMismatches, targetPath));
      for (const { key } of [...structureMismatches, ...pluralShapeMismatches]) reshapedKeys.add(key);
      for (const key of findPluralizedFlatKeys(sourceKeys, targetKeys)) reshapedKeys.add(key);

      if (targetPath) {
        pairedTargetKeys.set(targetPath, targetKeys);
        pairedSources.set(targetPath, [...(pairedSources.get(targetPath) ?? []), sourceFile.path]);
      }
      report.missingPluralCategories.push(...withPath(findMissingPluralCategories(targetKeys, locale), targetPath));
    }

    // Rails merges every file of a locale, so a target key is an orphan only when no source file has it.
    for (const [targetPath, targetKeys] of pairedTargetKeys) {
      const reshaped = new Set([...reshapedKeys, ...reshapedKeysBetween(allSourceKeys, targetKeys)]);
      const orphans = findOrphanKeys(allSourceKeys, targetKeys).filter((f) => !isAtOrUnder(f.key, reshaped));
      report.orphans.push(...withPath(orphans, targetPath));
    }

    // Only single-language YAML shares one namespace per locale: gettext domains, i18next namespaces
    // and multi-language files (often scoped to one view) are separate.
    report.conflictingKeys = findConflictingKeys(
      targetFiles.filter((file) => isYaml(file) && !file.multiLanguage).map((file) => ({ path: file.path, keys: withoutIgnored(keysOf(file, locale, sourceLocale)) }))
    );

    const reportedElsewhere = new Set([...reshapedKeys, ...report.empty.map((f) => f.key)]);
    const existingTargets = new Set(filesFor(locale));
    for (const entry of Object.values(missing)) {
      if (entry.locale !== locale) continue;
      // Without a config the targets are guessed, so a language that only
      // translates part of the app is not reported missing for the rest.
      if (detected && !existingTargets.has(entry.targetPath)) {
        report.missingFiles.push(entry.path);
        continue;
      }
      for (const key of Object.keys(entry.keys)) {
        if (ignoreMatcher(key) || isAtOrUnder(key, reportedElsewhere)) continue;
        report.missing.push({ key, path: entry.path, targetPath: entry.targetPath });
      }
    }

    if (keyChanges) tagIntroduced(report, keyChanges, pairedSources, sourcePaths);
    return report;
  });

  const failOn = options.failOn || 'missing';
  // Without the diff, failing on every existing finding would block pull requests that did not cause them.
  const findingsFail =
    !(changeStatus && 'error' in changeStatus) && shouldFail(reports.map((r) => filterFindings(r, isIntroduced)), failOn);
  const exitCode = findingsFail || (parseFailures.length > 0 && failOn !== 'none') ? 1 : 0;

  return {
    aborted: false,
    exitCode,
    reports,
    sourceLocale,
    sourceFiles: sourceFiles.map((f) => f.path),
    keyCount: totalSourceKeys.size,
    parseFailures,
    detected,
    format,
    changes: changeStatus,
    fileContents: rawContents(discovered.allFiles)
  };
}

// Files rebuilt because of duplicate keys are left out: their lines no longer match the repo.
function rawContents(files: TranslationFile[]): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const file of files) {
    if (file.content && !(file.path in contents)) {
      contents[file.path] = Buffer.from(file.content, 'base64').toString('utf8');
    }
  }
  return contents;
}

type LineOf = (file: string, key: string, locale: string) => number | undefined;

function lineLocator(contents: Record<string, string>): LineOf {
  const finders = new Map<string, KeyLineLookup>();
  return (file, key, locale) => {
    const content = contents[file];
    if (content === undefined) return undefined;
    const cacheKey = `${file}\u0000${locale}`;
    let find = finders.get(cacheKey);
    if (!find) {
      find = keyLineFinder(content, formatOf(file), locale);
      finders.set(cacheKey, find);
    }
    return find(key) ?? undefined;
  };
}

function shouldFail(reports: LocaleReport[], failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  const totalMissing = reports.reduce((sum, r) => sum + missingCount(r), 0);
  const placeholderCount = reports.reduce((sum, r) => sum + r.placeholderMismatches.length, 0);
  if (failOn === 'missing') return totalMissing > 0;
  if (failOn === 'placeholders') return placeholderCount > 0;
  // Orphans never fail a run: a target-only key is as often an unloaded file or a
  // framework's bundled translations as a real leftover, too unreliable to break CI.
  const structureCount = reports.reduce(
    (sum, r) =>
      sum +
      r.structureMismatches.length +
      r.pluralShapeMismatches.length +
      r.missingPluralCategories.length +
      r.conflictingKeys.length +
      r.duplicateKeys.length,
    0
  );
  return totalMissing > 0 || placeholderCount > 0 || structureCount > 0;
}

function truncate(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function printList<T>(
  con: CheckDependencies['console'],
  title: string,
  items: T[],
  render: (item: T) => string,
  all: boolean,
  cap = 10
): void {
  if (items.length === 0) return;
  con.log(chalk.bold(`\n${title} (${items.length}):`));
  const shown = all ? items : items.slice(0, cap);
  for (const item of shown) con.log(`  ${render(item)}`);
  if (!all && items.length > cap) con.log(chalk.dim(`  ... and ${items.length - cap} more`));
}

function printHumanReport(
  con: CheckDependencies['console'],
  reports: LocaleReport[],
  keyCount: number,
  all: boolean
): void {
  if (reports.length === 0) return;
  con.log(chalk.bold('\nLocale        Keys   Missing  Placeholders  Orphans  Complete'));
  for (const r of reports) {
    const missing = missingCount(r);
    const complete = keyCount === 0 ? 100 : Math.round(((keyCount - missing) / keyCount) * 100);
    con.log(
      `${r.locale.padEnd(14)}${String(keyCount).padEnd(7)}${String(missing).padEnd(9)}${String(r.placeholderMismatches.length).padEnd(14)}${String(r.orphans.length).padEnd(9)}${complete}%`
    );
  }

  const totalPlaceholders = reports.reduce((sum, r) => sum + r.placeholderMismatches.length, 0);
  const totalOrphans = reports.reduce((sum, r) => sum + r.orphans.length, 0);
  const totalMissing = reports.reduce((sum, r) => sum + missingCount(r), 0);
  const totalPossible = keyCount * reports.length;
  const overallComplete = totalPossible === 0 ? 100 : Math.round(((totalPossible - totalMissing) / totalPossible) * 100);
  con.log(
    chalk.bold(
      `\n${reports.length} locale(s), ${keyCount} keys, ${overallComplete}% complete, ${totalPlaceholders} placeholder mismatches, ${totalOrphans} orphans`
    )
  );
  printFindings(con, reports, all);
}

function placeholderProblem(m: PlaceholderMismatch): string {
  return [
    m.missingInTarget.length ? `missing ${spellPlaceholders(m.missingInTarget, m.source).join(' ')}` : '',
    m.unexpectedInTarget.length ? `unexpected ${spellPlaceholders(m.unexpectedInTarget, m.target).join(' ')}` : ''
  ]
    .filter(Boolean)
    .join(', ');
}

function printFindings(con: CheckDependencies['console'], reports: LocaleReport[], all: boolean): void {
  for (const r of reports) {
    con.log(chalk.bold(`\n== ${r.locale} ==`));
    printList(con, 'Missing keys', r.missing, (m) => m.key, all);
    printList(con, 'Empty values', r.empty, (m) => `${m.key}: "${truncate(m.source)}" -> ""`, all);
    printList(
      con,
      'Placeholder mismatches',
      r.placeholderMismatches,
      (m) => `${m.key}: "${truncate(m.source)}" -> "${truncate(m.target)}" [${placeholderProblem(m)}]`,
      all
    );
    printList(
      con,
      'Placeholder hints (a plural form may leave out a placeholder)',
      r.placeholderHints,
      (m) => `${m.key}: "${truncate(m.source)}" -> "${truncate(m.target)}" [omits: ${spellPlaceholders(m.missingInTarget, m.source).join(', ')}]`,
      all
    );
    printList(con, 'Orphan keys', r.orphans, (m) => `${m.key}: "${truncate(m.target ?? '')}"`, all);
    printList(
      con,
      'Structure mismatches',
      r.structureMismatches,
      (m) => `${m.key}: source is ${m.sourceShape}, target is ${m.targetShape}`,
      all
    );
    printList(con, 'Plural shape mismatches', r.pluralShapeMismatches, (m) => m.key, all);
    printList(
      con,
      'Missing plural categories (falls back to `other`)',
      r.missingPluralCategories,
      (m) => `${m.key}: needs ${m.missing.join(', ')}`,
      all
    );
    printList(
      con,
      'Conflicting values (defined differently in several files)',
      r.conflictingKeys,
      (m) => `${m.key}: ${m.files.join(', ')}`,
      all
    );
    printList(
      con,
      'Duplicate keys (the last value wins)',
      r.duplicateKeys,
      (m) => `${m.key}: ${m.values.map((v) => `"${truncate(v, 30)}"`).join(' then ')} in ${m.path}`,
      all
    );
    printList(con, `Not checked: no ${r.locale} file for`, r.missingFiles, (m) => m, all);
    printList(con, 'Identical to source (hint)', r.identical, (m) => `${m.key}: "${truncate(m.value)}"`, all);
  }
}

function escapeAnnotationData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeAnnotationProperty(text: string): string {
  return escapeAnnotationData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// GitHub shows only a handful of annotations per run; thousands just bury the log.
const MAX_ANNOTATIONS = 50;

interface Annotation {
  level: 'error' | 'warning' | 'notice';
  locale: string;
  file: string;
  line?: number;
  message: string;
}

// A missing translation points at the source key's line: in a pull request that
// added the key, that line is in the diff, so GitHub shows the annotation inline.
function annotationsFor(reports: LocaleReport[], sourceLocale: string, lineOf: LineOf = () => undefined): Annotation[] {
  const annotations: Annotation[] = [];
  for (const r of reports) {
    const annotate = (level: Annotation['level'], file: string, message: string, key?: string) =>
      annotations.push({
        level,
        locale: r.locale,
        file,
        line: key === undefined ? undefined : lineOf(file, key, r.locale),
        message
      });
    for (const m of r.missing) {
      annotations.push({
        level: 'error',
        locale: r.locale,
        file: m.path,
        line: lineOf(m.path, m.key, sourceLocale),
        message: `Missing translation for "${m.key}" (locale ${r.locale})`
      });
    }
    for (const m of r.empty) {
      annotate('error', m.path, `Empty translation for "${m.key}" (locale ${r.locale})`, m.key);
    }
    for (const m of r.placeholderMismatches) {
      annotate('error', m.path, `Placeholder mismatch for "${m.key}" (locale ${r.locale}): ${placeholderProblem(m)}`, m.key);
    }
    for (const m of r.missingPluralCategories) {
      annotate('error', m.path, `"${m.key}" lacks plural forms ${m.missing.join(', ')} (locale ${r.locale})`, m.key);
    }
    for (const m of r.placeholderHints) {
      const omitted = spellPlaceholders(m.missingInTarget, m.source).join(', ');
      annotate('notice', m.path, `Plural form omits ${omitted} for "${m.key}" (locale ${r.locale})`, m.key);
    }
    for (const m of r.orphans) {
      annotate('warning', m.path, `Orphan key "${m.key}" (locale ${r.locale}) no longer in source`, m.key);
    }
    for (const m of r.structureMismatches) {
      annotate('error', m.path, `Structure mismatch for "${m.key}" (locale ${r.locale})`, m.key);
    }
    for (const m of r.pluralShapeMismatches) {
      annotate('error', m.path, `Plural shape mismatch for "${m.key}" (locale ${r.locale})`, m.key);
    }
    for (const m of r.conflictingKeys) {
      annotate('error', m.files[0], `"${m.key}" has different values in ${m.files.join(', ')} (locale ${r.locale})`, m.key);
    }
    for (const m of r.duplicateKeys) {
      annotate('warning', m.path, `"${m.key}" is defined ${m.values.length} times; the last value wins (locale ${r.locale})`, m.key);
    }
  }
  return annotations;
}

function problemsIn(reports: LocaleReport[], sourceLocale: string): Annotation[] {
  return annotationsFor(reports, sourceLocale).filter((a) => a.level !== 'notice');
}

function printGithubAnnotations(con: CheckDependencies['console'], annotations: Annotation[]): void {
  const lines = annotations.map(({ level, file, line, message }) => {
    const where = line === undefined ? '' : `,line=${line}`;
    return `::${level} file=${escapeAnnotationProperty(file)}${where}::${escapeAnnotationData(message)}`;
  });
  for (const line of lines.slice(0, MAX_ANNOTATIONS)) con.log(line);
  if (lines.length > MAX_ANNOTATIONS) {
    con.log(`::warning::${lines.length - MAX_ANNOTATIONS} more findings not shown. Run check --json for the full report.`);
  }
}

function problemCounts(r: LocaleReport): ProblemCounts {
  return {
    missing: missingCount(r),
    placeholders: r.placeholderMismatches.length,
    plurals: r.missingPluralCategories.length + r.pluralShapeMismatches.length,
    structure: r.structureMismatches.length,
    conflicts: r.conflictingKeys.length + r.duplicateKeys.length,
    orphans: r.orphans.length
  };
}

function unavailableMessage(error: string): string {
  return `Could not compare with the base branch: ${error}. Checked every key instead; its findings do not fail the run. In GitHub Actions, check out with fetch-depth: 0 if this keeps happening.`;
}

function unchangedKeyProblems(count: number): string {
  return `${plural(count, 'problem')} in keys that did not change ${count === 1 ? 'is' : 'are'}`;
}

function changedOnlyJson(changes: ChangeStatus) {
  if (changes === null) return null;
  if ('error' in changes) return { base: null, diffAvailable: false, reason: changes.error };
  return { base: changes.base, diffAvailable: true };
}

function printJsonReport(con: CheckDependencies['console'], result: CheckResult): void {
  con.log(
    JSON.stringify({
      sourceLocale: result.sourceLocale,
      sourceFiles: result.sourceFiles,
      keyCount: result.keyCount,
      parseFailures: result.parseFailures,
      detected: result.detected,
      changedOnly: changedOnlyJson(result.changes),
      locales: result.reports.map((r) => ({
        locale: r.locale,
        files: r.files,
        keyCount: r.keyCount,
        missing: r.missing,
        empty: r.empty,
        identical: r.identical,
        placeholderMismatches: r.placeholderMismatches,
        placeholderHints: r.placeholderHints,
        missingPluralCategories: r.missingPluralCategories,
        orphans: r.orphans,
        structureMismatches: r.structureMismatches,
        pluralShapeMismatches: r.pluralShapeMismatches,
        conflictingKeys: r.conflictingKeys,
        duplicateKeys: r.duplicateKeys,
        missingFiles: r.missingFiles
      }))
    })
  );
}

function countedInSummary(changes: ChangeStatus, reports: LocaleReport[]): LocaleReport[] {
  if (changes === null) return [];
  if ('error' in changes) return reports;
  return reports.map((r) => filterFindings(r, isExisting));
}

function writeStepSummary(
  deps: CheckDependencies,
  path: string,
  changes: ChangeStatus,
  reports: LocaleReport[],
  sourceLocale: string
): void {
  const listed = changes !== null && 'error' in changes ? [] : reports.map((r) => filterFindings(r, isIntroduced));
  const markdown = buildStepSummary({
    changes,
    problems: problemsIn(listed, sourceLocale),
    counts: countedInSummary(changes, reports).map((r) => ({ locale: r.locale, counts: problemCounts(r) })),
    missingTranslations: reports.some((r) => missingCount(r) > 0)
  });
  try {
    deps.appendFile(path, `${markdown}\n`);
  } catch (error) {
    deps.console.error(chalk.yellow(`⚠ Could not write the job summary: ${(error as Error).message}`));
  }
}

export async function check(options: CheckOptions = {}, deps: CheckDependencies = defaultDeps): Promise<void> {
  const con = deps.console;
  const result = await runCheck(options, deps);
  const { reports, sourceLocale, keyCount, format, changes, fileContents } = result;
  process.exitCode = result.exitCode;
  if (result.aborted) return;

  const unavailable = changes !== null && 'error' in changes ? changes.error : null;
  const base = changes !== null && 'base' in changes ? changes.base : null;
  const introduced = reports.map((r) => filterFindings(r, isIntroduced));
  const existingProblems = base ? problemsIn(reports.map((r) => filterFindings(r, isExisting)), sourceLocale).length : 0;
  const summaryPath = detectCiContext(deps.env).stepSummaryPath;

  if (format === 'json') {
    if (unavailable) con.error(chalk.yellow(`⚠ ${unavailableMessage(unavailable)}`));
    printJsonReport(con, result);
  } else if (format === 'github') {
    if (unavailable) {
      con.log(`::warning::${escapeAnnotationData(unavailableMessage(unavailable))}`);
    } else {
      printGithubAnnotations(con, annotationsFor(introduced, sourceLocale, lineLocator(fileContents)));
    }
    if (base) {
      const where = summaryPath ? 'counted in the job summary' : 'not listed; run with --full to see them';
      con.log(`Checked the keys changed since ${base}. ${unchangedKeyProblems(existingProblems)} ${where}.`);
    }
  } else if (base) {
    con.log(chalk.blue(`ℹ Checking the keys changed since ${base}.`));
    printFindings(con, introduced, Boolean(options.all));
    con.log(`\n${unchangedKeyProblems(existingProblems)} not listed. Run with --full to see them.`);
  } else {
    if (unavailable) con.log(chalk.yellow(`⚠ ${unavailableMessage(unavailable)}`));
    printHumanReport(con, reports, keyCount, Boolean(options.all));
  }

  if (summaryPath) writeStepSummary(deps, summaryPath, changes, reports, sourceLocale);
}
