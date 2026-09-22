import chalk from 'chalk';
import { configService, type ConfigService } from '../utils/config.js';
import { findTranslationFiles, parseFile, flattenTranslations } from '../utils/files.js';
import {
  findMissingTranslationsByLocale,
  findTargetFile,
  processTargetContent
} from '../utils/translation-utils.js';
import {
  findOrphanKeys,
  findPlaceholderMismatches,
  findStructureMismatches,
  findPluralShapeMismatches,
  findEmptyAndIdentical,
  toStringValue,
  type FlatMap,
  type OrphanFinding,
  type PlaceholderMismatch,
  type StructureMismatch,
  type PluralShapeMismatch,
  type EmptyFinding,
  type IdenticalFinding
} from '../utils/check-utils.js';
import type {
  ProjectConfig,
  TranslationConfig,
  TranslationFileOptions,
  TranslationFile as OriginalTranslationFile,
  TranslationFilesResult as OriginalTranslationFilesResult
} from '../types/index.js';

export type FailOn = 'missing' | 'placeholders' | 'any' | 'none';

export interface CheckOptions {
  source?: string;
  locales?: string;
  json?: boolean;
  all?: boolean;
  failOn?: FailOn;
  format?: 'github';
  [key: string]: any;
}

interface TranslationFile extends OriginalTranslationFile {
  [key: string]: any;
}

interface TranslationFilesResult extends OriginalTranslationFilesResult {
  sourceFiles: TranslationFile[];
  targetFilesByLocale: Record<string, TranslationFile[]>;
  allFiles: TranslationFile[];
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
    ) => Promise<OriginalTranslationFile[] | OriginalTranslationFilesResult>;
  };
}

const defaultDeps: CheckDependencies = {
  console,
  configUtils: configService,
  fileUtils: { findTranslationFiles }
};

interface LocaleReport {
  locale: string;
  keyCount: number;
  missing: { key: string; path: string; targetPath: string }[];
  empty: (EmptyFinding & { path: string })[];
  identical: (IdenticalFinding & { path: string })[];
  placeholderMismatches: (PlaceholderMismatch & { path: string })[];
  orphans: (OrphanFinding & { path: string })[];
  structureMismatches: (StructureMismatch & { path: string })[];
  pluralShapeMismatches: (PluralShapeMismatch & { path: string })[];
}

function decode(file: TranslationFile): Record<string, any> {
  if (!file.content) return {};
  const raw = Buffer.from(file.content, 'base64').toString('utf8');
  return parseFile(raw, file.format, file.path, { sourceLanguage: file.locale });
}

function sourceKeysFor(sourceFile: TranslationFile, sourceLocale: string): FlatMap {
  const parsed = decode(sourceFile);
  const wrapper = parsed[sourceLocale];
  const tree = wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) ? wrapper : parsed;
  return flattenTranslations(tree, '', sourceFile.format);
}

function targetKeysFor(
  targetFiles: TranslationFile[],
  targetLocale: string,
  sourceFile: TranslationFile,
  sourceLocale: string
): { keys: FlatMap; path: string } {
  const targetFile = findTargetFile(targetFiles, targetLocale, sourceFile, sourceLocale);
  if (!targetFile) return { keys: {}, path: '' };
  const parsed = decode(targetFile);
  return { keys: processTargetContent(parsed, targetLocale, targetFile.format), path: targetFile.path };
}

export async function runCheck(
  options: CheckOptions = {},
  deps: CheckDependencies = defaultDeps
): Promise<{ exitCode: number; reports: LocaleReport[]; sourceLocale: string; sourceFiles: string[]; keyCount: number }> {
  const { console, configUtils, fileUtils } = deps;

  const config = await configUtils.getProjectConfig();
  if (!config) {
    console.error(chalk.red('\n✖ No configuration found. Please run `npx @localheroai/cli init` first.\n'));
    return { exitCode: 1, reports: [], sourceLocale: '', sourceFiles: [], keyCount: 0 };
  }
  if (!config.translationFiles?.paths) {
    console.error(chalk.red('\n✖ Invalid configuration: missing translationFiles.paths. Please run `npx @localheroai/cli init` to set up your configuration.\n'));
    return { exitCode: 1, reports: [], sourceLocale: '', sourceFiles: [], keyCount: 0 };
  }

  const sourceLocale = options.source || config.sourceLocale;
  const targetLocales = options.locales
    ? options.locales.split(',').map((l) => l.trim()).filter(Boolean)
    : config.outputLocales || [];

  const result = await fileUtils.findTranslationFiles(config as TranslationConfig, {
    returnFullResult: true,
    sourceLocale,
    targetLocales
  });
  const { sourceFiles, targetFilesByLocale, allFiles, parseFailures = [] } = result as TranslationFilesResult;

  if (!options.json && !options.format) {
    console.log(chalk.blue(`ℹ Source locale: ${sourceLocale} (${sourceFiles.map((f) => f.path).join(', ') || 'no source files found'})`));
    console.log(chalk.blue(`ℹ Target locales: ${targetLocales.join(', ') || 'none configured'}`));
  }

  if (parseFailures.length > 0 && !options.json) {
    console.error(chalk.red(`\n✖ ${parseFailures.length} translation file(s) could not be parsed and were skipped:`));
    for (const failure of parseFailures) {
      console.error(chalk.red(`  - ${failure.path}: ${failure.error}`));
    }
  }

  if (!allFiles || allFiles.length === 0) {
    console.error(chalk.red('\n✖ No translation files found in the specified paths.\n'));
    return { exitCode: 1, reports: [], sourceLocale, sourceFiles: [], keyCount: 0 };
  }

  const { missing } = findMissingTranslationsByLocale(
    sourceFiles,
    targetFilesByLocale,
    { sourceLocale, outputLocales: targetLocales },
    false
  );

  const sourceKeyMaps = sourceFiles.map((file) => ({ file, keys: sourceKeysFor(file, sourceLocale) }));
  const totalSourceKeys = new Set<string>();
  for (const { keys } of sourceKeyMaps) {
    for (const [key, value] of Object.entries(keys)) {
      if (toStringValue(value) !== '' && toStringValue(value) !== null) totalSourceKeys.add(key);
    }
  }

  const reports: LocaleReport[] = targetLocales.map((locale) => {
    const report: LocaleReport = {
      locale,
      keyCount: totalSourceKeys.size,
      missing: [],
      empty: [],
      identical: [],
      placeholderMismatches: [],
      orphans: [],
      structureMismatches: [],
      pluralShapeMismatches: []
    };

    for (const { file: sourceFile, keys: sourceKeys } of sourceKeyMaps) {
      const targetFiles = targetFilesByLocale[locale] || [];
      const { keys: targetKeys, path: targetPath } = targetKeysFor(targetFiles, locale, sourceFile, sourceLocale);

      const { empty, identical } = findEmptyAndIdentical(sourceKeys, targetKeys);
      report.empty.push(...empty.map((f) => ({ ...f, path: targetPath })));
      report.identical.push(...identical.map((f) => ({ ...f, path: targetPath })));
      report.placeholderMismatches.push(
        ...findPlaceholderMismatches(sourceKeys, targetKeys).map((f) => ({ ...f, path: targetPath }))
      );
      report.orphans.push(...findOrphanKeys(sourceKeys, targetKeys).map((f) => ({ ...f, path: targetPath })));
      report.structureMismatches.push(
        ...findStructureMismatches(sourceKeys, targetKeys).map((f) => ({ ...f, path: targetPath }))
      );
      report.pluralShapeMismatches.push(
        ...findPluralShapeMismatches(sourceKeys, targetKeys).map((f) => ({ ...f, path: targetPath }))
      );
    }

    for (const entry of Object.values(missing)) {
      if (entry.locale !== locale) continue;
      for (const key of Object.keys(entry.keys)) {
        report.missing.push({ key, path: entry.path, targetPath: entry.targetPath });
      }
    }

    return report;
  });

  const exitCode = shouldFail(reports, options.failOn || 'missing') ? 1 : 0;

  return { exitCode, reports, sourceLocale, sourceFiles: sourceFiles.map((f) => f.path), keyCount: totalSourceKeys.size };
}

function shouldFail(reports: LocaleReport[], failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  const missingCount = reports.reduce((sum, r) => sum + r.missing.length + r.empty.length, 0);
  const placeholderCount = reports.reduce((sum, r) => sum + r.placeholderMismatches.length, 0);
  if (failOn === 'missing') return missingCount > 0;
  if (failOn === 'placeholders') return placeholderCount > 0;
  const orphanCount = reports.reduce((sum, r) => sum + r.orphans.length, 0);
  const structureCount = reports.reduce(
    (sum, r) => sum + r.structureMismatches.length + r.pluralShapeMismatches.length,
    0
  );
  return missingCount > 0 || placeholderCount > 0 || orphanCount > 0 || structureCount > 0;
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
) {
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
  con.log(chalk.bold('\nLocale        Keys   Missing  Placeholders  Orphans  Complete'));
  for (const r of reports) {
    const complete = keyCount === 0 ? 100 : Math.round(((keyCount - r.missing.length - r.empty.length) / keyCount) * 100);
    con.log(
      `${r.locale.padEnd(14)}${String(keyCount).padEnd(7)}${String(r.missing.length + r.empty.length).padEnd(9)}${String(r.placeholderMismatches.length).padEnd(14)}${String(r.orphans.length).padEnd(9)}${complete}%`
    );
  }

  const totalPlaceholders = reports.reduce((sum, r) => sum + r.placeholderMismatches.length, 0);
  const totalOrphans = reports.reduce((sum, r) => sum + r.orphans.length, 0);
  const totalMissing = reports.reduce((sum, r) => sum + r.missing.length + r.empty.length, 0);
  const totalPossible = keyCount * reports.length;
  const overallComplete = totalPossible === 0 ? 100 : Math.round(((totalPossible - totalMissing) / totalPossible) * 100);
  con.log(
    chalk.bold(
      `\n${reports.length} locale(s), ${keyCount} keys, ${overallComplete}% complete, ${totalPlaceholders} placeholder mismatches, ${totalOrphans} orphans`
    )
  );

  for (const r of reports) {
    con.log(chalk.bold(`\n== ${r.locale} ==`));
    printList(con, 'Missing keys', r.missing, (m) => `${m.key}`, all);
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
    printList(con, 'Orphan keys', r.orphans, (m) => `${m.key}: "${truncate(m.target ?? '')}"`, all);
    printList(
      con,
      'Structure mismatches',
      r.structureMismatches,
      (m) => `${m.key}: source is ${m.sourceShape}, target is ${m.targetShape}`,
      all
    );
    printList(con, 'Plural shape mismatches', r.pluralShapeMismatches, (m) => `${m.key}`, all);
    printList(
      con,
      'Identical to source (hint)',
      r.identical,
      (m) => `${m.key}: "${truncate(m.value)}"`,
      all
    );
  }
}

function printGithubAnnotations(con: CheckDependencies['console'], reports: LocaleReport[]): void {
  // Locale files parsed here are not tracked with line numbers, so
  // annotations are file-level rather than line-level. That is honest
  // about what this command can locate, not a guess.
  for (const r of reports) {
    for (const m of r.missing) {
      con.log(`::error file=${m.targetPath}::Missing translation for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.empty) {
      con.log(`::error file=${m.path}::Empty translation for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.placeholderMismatches) {
      con.log(`::error file=${m.path}::Placeholder mismatch for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.orphans) {
      con.log(`::warning file=${m.path}::Orphan key "${m.key}" (locale ${r.locale}) no longer in source`);
    }
    for (const m of r.structureMismatches) {
      con.log(`::error file=${m.path}::Structure mismatch for "${m.key}" (locale ${r.locale})`);
    }
    for (const m of r.pluralShapeMismatches) {
      con.log(`::error file=${m.path}::Plural shape mismatch for "${m.key}" (locale ${r.locale})`);
    }
  }
}

export async function check(options: CheckOptions = {}, deps: CheckDependencies = defaultDeps): Promise<void> {
  const con = deps.console ?? console;
  const { exitCode, reports, sourceLocale, sourceFiles, keyCount } = await runCheck(options, deps);

  if (options.json) {
    con.log(
      JSON.stringify({
        sourceLocale,
        sourceFiles,
        keyCount,
        locales: reports.map((r) => ({
          locale: r.locale,
          keyCount: r.keyCount,
          missing: r.missing,
          empty: r.empty,
          identical: r.identical,
          placeholderMismatches: r.placeholderMismatches,
          orphans: r.orphans,
          structureMismatches: r.structureMismatches,
          pluralShapeMismatches: r.pluralShapeMismatches
        }))
      })
    );
  } else if (options.format === 'github') {
    printGithubAnnotations(con, reports);
  } else {
    printHumanReport(con, reports, keyCount, Boolean(options.all));
  }

  process.exitCode = exitCode;
}
