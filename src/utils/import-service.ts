import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { createImport, checkImportStatus, ImportResponse, bulkUpdateTranslations } from '../api/imports.js';
import { findTranslationFiles as findFiles, flattenTranslations } from './files.js';
import { parsePoFile, poEntriesToApiFormat } from './po-utils.js';
import { filterFilesByGitChanges } from './git-changes.js';
import { detectMultiLanguage } from './multi-language-detection.js';
import type { RemovedKey } from './ignore-keys.js';
import type {
  ProjectConfig,
  TranslationFile,
  TranslationFileOptions,
  PrunableKey,
  ImportFile
} from '../types/index.js';

export type { PrunableKey, ImportFile };

export type FileFormat = 'json' | 'yaml' | 'po' | 'pot' | null;

export interface ImportResult {
  status: string;
  error?: string;
  statistics?: {
    created_translations: number;
    updated_translations: number;
  };
  warnings?: string[];
  translations_url?: string;
  sourceImport?: boolean;
  files?: {
    source: ImportFile[];
    target: ImportFile[];
  };
  poll_interval?: number;
  id?: string;
  prunable_keys?: PrunableKey[];
}

export interface KeyIdentifier {
  name: string;
  context: string | null;
}

export interface TranslationRecord {
  language: string;
  format: string;
  filename: string;
  content: string;
  keys?: KeyIdentifier[];
  multi_language?: boolean;
}

export interface FilterOptions {
  ignoreMatcher?: (keyName: string) => boolean;
  knownLocales?: string[];
  sourceLocale?: string;
}

export interface FileReadResult {
  content: string;
  keys: KeyIdentifier[];
  removed: RemovedKey[];
}

function getFileFormat(filePath: string): FileFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.po') return 'po';
  if (ext === '.pot') return 'pot';
  return null;
}

function normalizeFormat(format: string): string {
  if (format === 'yml') return 'yaml';
  if (format === 'pot') return 'po';
  return format;
}

let poWarningEmitted = false;

export function resetPoWarning(): void {
  poWarningEmitted = false;
}

type Subtree = {
  obj: Record<string, unknown>;
  pathPrefix: string[];
  locale: string | undefined;
};

function buildSubtrees(
  parsed: unknown,
  knownLocales: string[],
  sourceLocale: string | undefined,
  currentLanguage: string | undefined
): Subtree[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const topKeys = Object.keys(obj);

  if (detectMultiLanguage(parsed, knownLocales)) {
    return topKeys.map((loc) => ({
      obj: (obj[loc] ?? {}) as Record<string, unknown>,
      pathPrefix: [loc],
      locale: loc === sourceLocale ? undefined : loc,
    }));
  }

  if (topKeys.length === 1 && knownLocales.includes(topKeys[0])) {
    const loc = topKeys[0];
    return [
      {
        obj: (obj[loc] ?? {}) as Record<string, unknown>,
        pathPrefix: [loc],
        locale: loc === sourceLocale ? undefined : loc,
      },
    ];
  }

  const tag = currentLanguage && currentLanguage !== sourceLocale ? currentLanguage : undefined;
  return [{ obj, pathPrefix: [], locale: tag }];
}

function readYaml(
  content: string,
  matcher: ((k: string) => boolean) | undefined,
  knownLocales: string[],
  sourceLocale: string | undefined,
  currentLanguage: string | undefined
): FileReadResult {
  try {
    const parsed = yaml.parse(content);
    if (!matcher) {
      const flat = flattenTranslations(parsed);
      return {
        content: Buffer.from(content).toString('base64'),
        keys: Object.keys(flat).map((name) => ({ name, context: null })),
        removed: [],
      };
    }

    const doc = yaml.parseDocument(content);
    const subtrees = buildSubtrees(parsed, knownLocales, sourceLocale, currentLanguage);
    const removed: RemovedKey[] = [];

    for (const { obj, pathPrefix, locale } of subtrees) {
      const flat = flattenTranslations(obj);
      for (const flatKey of Object.keys(flat)) {
        if (matcher(flatKey)) {
          doc.deleteIn([...pathPrefix, ...flatKey.split('.')]);
          removed.push({ name: flatKey, locale });
        }
      }
    }

    const serialized = doc.toString();
    const postParsed = yaml.parse(serialized);
    const postFlat = flattenTranslations(postParsed);
    return {
      content: Buffer.from(serialized).toString('base64'),
      keys: Object.keys(postFlat).map((name) => ({ name, context: null })),
      removed,
    };
  } catch {
    return { content: Buffer.from(content).toString('base64'), keys: [], removed: [] };
  }
}

function readJson(
  content: string,
  matcher: ((k: string) => boolean) | undefined,
  knownLocales: string[],
  sourceLocale: string | undefined,
  currentLanguage: string | undefined
): FileReadResult {
  try {
    const parsed = JSON.parse(content);
    if (!matcher) {
      const flat = flattenTranslations(parsed);
      return {
        content: Buffer.from(JSON.stringify(flat)).toString('base64'),
        keys: Object.keys(flat).map((name) => ({ name, context: null })),
        removed: [],
      };
    }

    const subtrees = buildSubtrees(parsed, knownLocales, sourceLocale, currentLanguage);
    const removed: RemovedKey[] = [];
    const keptFlat: Record<string, unknown> = {};

    for (const { obj, pathPrefix, locale } of subtrees) {
      const flat = flattenTranslations(obj);
      for (const [name, value] of Object.entries(flat)) {
        if (matcher(name)) {
          removed.push({ name, locale });
          continue;
        }
        const fullKey = pathPrefix.length > 0 ? `${pathPrefix.join('.')}.${name}` : name;
        keptFlat[fullKey] = value;
      }
    }
    return {
      content: Buffer.from(JSON.stringify(keptFlat)).toString('base64'),
      keys: Object.keys(keptFlat).map((name) => ({ name, context: null })),
      removed,
    };
  } catch {
    return { content: Buffer.from(content).toString('base64'), keys: [], removed: [] };
  }
}

function readPo(
  content: string,
  options: { sourceLanguage?: string; currentLanguage?: string } | undefined,
  matcher: ((k: string) => boolean) | undefined
): FileReadResult {
  if (matcher && !poWarningEmitted) {
    console.warn(chalk.yellow('⚠ ignoreKeys does not yet support PO files; PO files will be uploaded unfiltered.'));
    poWarningEmitted = true;
  }
  try {
    const parsed = parsePoFile(content);
    const apiFormat = poEntriesToApiFormat(parsed, options);
    const keys: KeyIdentifier[] = [];
    for (const entry of parsed.entries) {
      if (entry.msgid) keys.push({ name: entry.msgid, context: entry.msgctxt || null });
    }
    return {
      content: Buffer.from(JSON.stringify(apiFormat)).toString('base64'),
      keys,
      removed: [],
    };
  } catch {
    return { content: Buffer.from(content).toString('base64'), keys: [], removed: [] };
  }
}

export async function readFileContentWithKeys(
  filePath: string,
  options?: { sourceLanguage?: string; currentLanguage?: string },
  filterOptions?: FilterOptions
): Promise<FileReadResult> {
  const content = await fs.readFile(filePath, 'utf8');
  const format = getFileFormat(filePath);
  const matcher = filterOptions?.ignoreMatcher;
  const knownLocales = filterOptions?.knownLocales ?? [];
  const sourceLocale = filterOptions?.sourceLocale;
  const currentLanguage = options?.currentLanguage;

  if (format === 'yaml') {
    return readYaml(content, matcher, knownLocales, sourceLocale, currentLanguage);
  }
  if (format === 'json') {
    return readJson(content, matcher, knownLocales, sourceLocale, currentLanguage);
  }
  if (format === 'po' || format === 'pot') {
    return readPo(content, options, matcher);
  }
  return { content: Buffer.from(content).toString('base64'), keys: [], removed: [] };
}

async function readFileContent(
  filePath: string,
  options?: { sourceLanguage?: string; currentLanguage?: string }
): Promise<string> {
  const result = await readFileContentWithKeys(filePath, options);
  return result.content;
}

export const importService = {
  async findTranslationFiles(
    config: ProjectConfig,
    basePath = process.cwd()
  ): Promise<ImportFile[]> {
    const options: TranslationFileOptions = {
      basePath,
      parseContent: false,
      includeContent: false,
      extractKeys: false,
      includeNamespace: true,
      returnFullResult: false
    };

    const files = await findFiles(config, options) as TranslationFile[];

    return files.map(file => ({
      path: path.isAbsolute(file.path) ? path.relative(basePath, file.path) : file.path,
      language: file.locale,
      format: normalizeFormat(file.format),
      namespace: file.namespace || '',
      multi_language: file.multiLanguage ?? false
    }));
  },

  async importTranslations(
    config: ProjectConfig,
    basePath = process.cwd()
  ): Promise<ImportResult> {
    const files = await this.findTranslationFiles(config, basePath);

    if (!files.length) {
      return { status: 'no_files' };
    }

    const sourceFiles = files.filter(file => file.language === config.sourceLocale);
    const targetFiles = files.filter(file => file.language !== config.sourceLocale);
    const importedFiles = {
      source: sourceFiles,
      target: targetFiles
    };

    if (!sourceFiles.length) {
      return {
        status: 'failed',
        error: 'No source language files found. Source language files must be included in the first import.',
        files: importedFiles
      };
    }

    const allTranslations: TranslationRecord[] = [];

    for (const file of sourceFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: normalizeFormat(file.format),
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        }),
        multi_language: file.multi_language ?? false
      });
    }

    for (const file of targetFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: normalizeFormat(file.format),
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        }),
        multi_language: file.multi_language ?? false
      });
    }

    const importResult = await createImport({
      projectId: config.projectId,
      translations: allTranslations
    });

    if (importResult.import?.status === 'failed') {
      return {
        ...importResult.import,
        files: importedFiles
      };
    }

    let finalImportResult: ImportResponse = importResult;
    while (finalImportResult.import?.status === 'processing') {
      const pollInterval = finalImportResult.import.poll_interval || 5;
      await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
      finalImportResult = await checkImportStatus(config.projectId, finalImportResult.import.id);

      if (finalImportResult.import?.status === 'failed') {
        return {
          ...finalImportResult.import,
          files: importedFiles
        };
      }
    }

    const {
      import: {
        status = 'completed',
        statistics,
        warnings,
        translations_url,
        sourceImport
      } = {}
    } = finalImportResult;

    return {
      status,
      statistics,
      warnings,
      translations_url,
      sourceImport,
      files: importedFiles
    };
  },

  async pushTranslations(
    config: ProjectConfig,
    basePath = process.cwd(),
    options: { force?: boolean; verbose?: boolean; prune?: boolean } = {}
  ): Promise<ImportResult> {
    let files = await this.findTranslationFiles(config, basePath);

    if (!files.length) {
      return { status: 'no_files' };
    }

    if (!options.force) {
      const filteredFiles = filterFilesByGitChanges(files, config, options.verbose || false);
      if (filteredFiles !== null) {
        if (filteredFiles.length === 0) {
          return {
            status: 'no_changes',
            files: { source: [], target: [] }
          };
        }
        files = filteredFiles;
      }
    } else if (options.verbose) {
      console.log(chalk.dim('--force flag set - pushing all files'));
    }

    const sourceFiles = files.filter(file => file.language === config.sourceLocale);
    const targetFiles = files.filter(file => file.language !== config.sourceLocale);
    const allTranslations: TranslationRecord[] = [];

    for (const file of sourceFiles) {
      const fullPath = path.join(basePath, file.path);
      const fileResult = await readFileContentWithKeys(fullPath, {
        sourceLanguage: config.sourceLocale,
        currentLanguage: file.language
      });

      const record: TranslationRecord = {
        language: file.language,
        format: normalizeFormat(file.format),
        filename: file.path,
        content: fileResult.content,
        multi_language: file.multi_language ?? false
      };

      if (options.prune) {
        record.keys = fileResult.keys;
      }

      allTranslations.push(record);
    }

    for (const file of targetFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: normalizeFormat(file.format),
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        }),
        multi_language: file.multi_language ?? false
      });
    }

    if (options.verbose) {
      console.log(chalk.blue(`Sending ${allTranslations.length} translation files to API`));
      allTranslations.forEach(t => {
        console.log(chalk.gray(`  - ${t.language} ${t.format} ${t.filename} (${t.content?.length || 0} bytes)`));
      });
    }

    const importResult = await bulkUpdateTranslations({
      projectId: config.projectId,
      translations: allTranslations,
      includePrunable: options.prune
    });

    if (importResult.import?.status === 'failed') {
      return {
        ...importResult.import,
        files: { source: [], target: files }
      };
    }

    let finalImportResult: ImportResponse = importResult;
    while (finalImportResult.import?.status === 'processing') {
      const pollInterval = finalImportResult.import.poll_interval || 5;
      await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
      finalImportResult = await checkImportStatus(config.projectId, finalImportResult.import.id);

      if (finalImportResult.import?.status === 'failed') {
        return {
          ...finalImportResult.import,
          files: { source: [], target: files }
        };
      }
    }

    const {
      import: {
        status = 'completed',
        statistics,
        warnings,
        translations_url,
        sourceImport,
        prunable_keys
      } = {}
    } = finalImportResult;

    return {
      status,
      statistics,
      warnings,
      translations_url,
      sourceImport,
      files: { source: sourceFiles, target: targetFiles },
      prunable_keys
    };
  }
};

export async function findTranslationFiles(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportFile[]> {
  return importService.findTranslationFiles(config, basePath);
}

export async function importTranslations(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportResult> {
  return importService.importTranslations(config, basePath);
}

export async function pushTranslations(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportResult> {
  return importService.pushTranslations(config, basePath);
}
