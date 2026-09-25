import chalk from 'chalk';
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
import type {
  TranslationConfig,
  TranslationFile,
  TranslationFileOptions,
  TranslationFilesResult
} from '../types/index.js';

const FAIL_ON_MODES = ['missing', 'placeholders', 'any', 'none'] as const;
const FORMATS = ['github'] as const;

export type FailOn = (typeof FAIL_ON_MODES)[number];

export interface CheckOptions {
  source?: string;
  locales?: string;
  json?: boolean;
  all?: boolean;
  failOn?: FailOn;
  format?: (typeof FORMATS)[number];
  path?: string;
  pattern?: string;
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
}

const defaultDeps: CheckDependencies = {
  console,
  configUtils: configService,
  fileUtils: { findTranslationFiles },
  projectDetection: { detectProjectType: defaultConfigDetectionDeps.detectProjectType },
  fsUtils: { listFiles: defaultConfigDetectionDeps.listFiles, readFile: defaultConfigDetectionDeps.readFile }
};

interface LocaleReport {
  locale: string;
  files: string[];
  keyCount: number;
  missing: { key: string; path: string; targetPath: string }[];
  empty: (EmptyFinding & { path: string })[];
  identical: (IdenticalFinding & { path: string })[];
  placeholderMismatches: (PlaceholderMismatch & { path: string })[];
  placeholderHints: (PlaceholderMismatch & { path: string })[];
  orphans: (OrphanFinding & { path: string })[];
  structureMismatches: (StructureMismatch & { path: string })[];
  pluralShapeMismatches: (PluralShapeMismatch & { path: string })[];
  missingPluralCategories: (MissingPluralCategories & { path: string })[];
  conflictingKeys: ConflictingKey[];
  duplicateKeys: { key: string; path: string; values: string[] }[];
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
}

function failedResult(sourceLocale = ''): CheckResult {
  return {
    aborted: true,
    exitCode: 1,
    reports: [],
    sourceLocale,
    sourceFiles: [],
    keyCount: 0,
    parseFailures: [],
    detected: null
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
  return null;
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

  const optionError = invalidOption(options);
  if (optionError) {
    console.error(chalk.red(`\n✖ ${optionError}\n`));
    return failedResult();
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
      return failedResult();
    }
    ({ config, detected } = detection);
  }
  if (!config.translationFiles?.paths) {
    console.error(chalk.red('\n✖ Invalid configuration: missing translationFiles.paths. Please run `npx @localheroai/cli init` to set up your configuration.\n'));
    return failedResult();
  }

  const sourceLocale = options.source || config.sourceLocale;
  const targetLocales = options.locales ? requestedLocales : config.outputLocales || [];

  const result = await fileUtils.findTranslationFiles(config, {
    returnFullResult: true,
    sourceLocale,
    targetLocales,
    ...(options.json ? { logger: { log: console.error } } : {})
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

  if (!options.json && !options.format) {
    if (detected) printDetected(console, detected, targetLocales.length);
    console.log(chalk.blue(`ℹ Source locale: ${sourceLocale} (${sourceFiles.map((f) => f.path).join(', ') || 'no source files found'})`));
    if (targetLocales.length === 0 && !detected) console.log(chalk.blue('ℹ Target locales: none configured'));
    for (const locale of targetLocales) {
      console.log(chalk.blue(`ℹ ${locale}: ${filesFor(locale).join(', ') || 'no files found'}`));
    }
  }

  if (parseFailures.length > 0 && !options.json) {
    console.error(chalk.red(`\n✖ ${parseFailures.length} translation file(s) could not be parsed and were skipped:`));
    for (const failure of parseFailures) {
      console.error(chalk.red(`  - ${failure.path}: ${failure.error}`));
    }
  }

  if (!allFiles || allFiles.length === 0) {
    console.error(chalk.red('\n✖ No translation files found in the specified paths.\n'));
    return failedResult(sourceLocale);
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

  const sourceKeyMaps = sourceFiles.map((file) => ({ file, keys: withoutIgnored(sourceKeysFor(file, sourceLocale)) }));
  const totalSourceKeys = new Set<string>();
  for (const { keys } of sourceKeyMaps) {
    for (const [key, value] of Object.entries(keys)) {
      const text = toStringValue(value);
      if (Array.isArray(value) || (text !== null && text !== '')) totalSourceKeys.add(key);
    }
  }
  const allSourceKeys: FlatMap = Object.assign({}, ...sourceKeyMaps.map(({ keys }) => keys));

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

      if (targetPath) pairedTargetKeys.set(targetPath, targetKeys);
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

    return report;
  });

  const failOn = options.failOn || 'missing';
  const exitCode = shouldFail(reports, failOn) || (parseFailures.length > 0 && failOn !== 'none') ? 1 : 0;

  return {
    aborted: false,
    exitCode,
    reports,
    sourceLocale,
    sourceFiles: sourceFiles.map((f) => f.path),
    keyCount: totalSourceKeys.size,
    parseFailures,
    detected
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

  for (const r of reports) {
    con.log(chalk.bold(`\n== ${r.locale} ==`));
    printList(con, 'Missing keys', r.missing, (m) => m.key, all);
    printList(con, 'Empty values', r.empty, (m) => `${m.key}: "${truncate(m.source)}" -> ""`, all);
    printList(
      con,
      'Placeholder mismatches',
      r.placeholderMismatches,
      (m) =>
        `${m.key}: "${truncate(m.source)}" -> "${truncate(m.target)}"` +
        (m.missingInTarget.length ? ` [missing: ${m.missingInTarget.join(', ')}]` : '') +
        (m.unexpectedInTarget.length ? ` [unexpected: ${m.unexpectedInTarget.join(', ')}]` : ''),
      all
    );
    printList(
      con,
      'Placeholder hints (a plural form may leave out a placeholder)',
      r.placeholderHints,
      (m) => `${m.key}: "${truncate(m.source)}" -> "${truncate(m.target)}" [omits: ${m.missingInTarget.join(', ')}]`,
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

function printGithubAnnotations(con: CheckDependencies['console'], reports: LocaleReport[]): void {
  const lines: string[] = [];
  const annotate = (level: 'error' | 'warning' | 'notice', file: string, message: string) =>
    lines.push(`::${level} file=${escapeAnnotationProperty(file)}::${escapeAnnotationData(message)}`);

  // Parsed locale files carry no line numbers, so annotations are file-level.
  for (const r of reports) {
    for (const m of r.missing) {
      annotate('error', m.targetPath, `Missing translation for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.empty) {
      annotate('error', m.path, `Empty translation for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.placeholderMismatches) {
      annotate('error', m.path, `Placeholder mismatch for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.missingPluralCategories) {
      annotate('error', m.path, `"${m.key}" lacks plural forms ${m.missing.join(', ')} (locale ${r.locale})`);
    }
    for (const m of r.placeholderHints) {
      annotate('notice', m.path, `Plural form omits ${m.missingInTarget.join(', ')} for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.orphans) {
      annotate('warning', m.path, `Orphan key "${m.key}" (locale ${r.locale}) no longer in source`);
    }
    for (const m of r.structureMismatches) {
      annotate('error', m.path, `Structure mismatch for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.pluralShapeMismatches) {
      annotate('error', m.path, `Plural shape mismatch for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.conflictingKeys) {
      annotate('error', m.files[0], `"${m.key}" has different values in ${m.files.join(', ')} (locale ${r.locale})`);
    }
    for (const m of r.duplicateKeys) {
      annotate('warning', m.path, `"${m.key}" is defined ${m.values.length} times; the last value wins (locale ${r.locale})`);
    }
  }

  for (const line of lines.slice(0, MAX_ANNOTATIONS)) con.log(line);
  if (lines.length > MAX_ANNOTATIONS) {
    con.log(`::warning::${lines.length - MAX_ANNOTATIONS} more findings not shown. Run check --json for the full report.`);
  }
}

export async function check(options: CheckOptions = {}, deps: CheckDependencies = defaultDeps): Promise<void> {
  const con = deps.console;
  const { aborted, exitCode, reports, sourceLocale, sourceFiles, keyCount, parseFailures, detected } = await runCheck(options, deps);
  process.exitCode = exitCode;
  if (aborted) return;

  if (options.json) {
    con.log(
      JSON.stringify({
        sourceLocale,
        sourceFiles,
        keyCount,
        parseFailures,
        detected,
        locales: reports.map((r) => ({
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
  } else if (options.format === 'github') {
    printGithubAnnotations(con, reports);
  } else {
    printHumanReport(con, reports, keyCount, Boolean(options.all));
  }
}
