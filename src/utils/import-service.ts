import { promises as fs } from 'fs';
import path from 'path';
import { createImport, checkImportStatus, ImportResponse, bulkUpdateTranslations } from '../api/imports.js';
import { findTranslationFiles as findFiles, flattenTranslations } from './files.js';
import { parsePoFile, poEntriesToApiFormat } from './po-utils.js';
import {
  ProjectConfig,
  TranslationFile,
  TranslationFileOptions
} from '../types/index.js';

/**
 * File format supported by the import service
 */
export type FileFormat = 'json' | 'yaml' | 'po' | null;

/**
 * File details for import operations
 */
export interface ImportFile {
  path: string;
  language: string;
  format: string;
  namespace: string;
}

/**
 * Result of the translation import
 */
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
}

/**
 * Translation record to import
 */
export interface TranslationRecord {
  language: string;
  format: string;
  filename: string;
  content: string;
}

/**
 * Get the file format based on extension
 * @param filePath Path to the file
 * @returns The file format or null if not supported
 */
function getFileFormat(filePath: string): FileFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.po') return 'po';
  return null;
}

/**
 * Read file content and convert to base64
 * @param filePath Path to the file
 * @param options Language context for proper handling
 * @returns Base64 encoded content
 */
async function readFileContent(
  filePath: string,
  options?: { sourceLanguage?: string; currentLanguage?: string }
): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  const format = getFileFormat(filePath);

  if (format === 'json') {
    try {
      const jsonContent = JSON.parse(content);
      const flattened = flattenTranslations(jsonContent);

      return Buffer.from(JSON.stringify(flattened)).toString('base64');
    } catch {
      return Buffer.from(content).toString('base64');
    }
  }

  if (format === 'po') {
    try {
      const parsed = parsePoFile(content);
      const apiFormat = poEntriesToApiFormat(parsed, options);

      return Buffer.from(JSON.stringify(apiFormat)).toString('base64');
    } catch {
      return Buffer.from(content).toString('base64');
    }
  }

  return Buffer.from(content).toString('base64');
}

export const importService = {
  /**
   * Find translation files based on configuration
   * @param config Project configuration
   * @param basePath Base path to look for files (defaults to cwd)
   * @returns Array of import file objects
   */
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
      format: file.format === 'yml' ? 'yaml' : file.format,
      namespace: file.namespace || ''
    }));
  },

  /**
   * Import translations from files
   * @param config Project configuration
   * @param basePath Base path to look for files (defaults to cwd)
   * @returns Result of the import operation
   */
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
        format: file.format === 'yml' ? 'yaml' : file.format,
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        })
      });
    }

    for (const file of targetFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: file.format === 'yml' ? 'yaml' : file.format,
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        })
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

  /**
   * Push local translations to the API
   * @param config Project configuration
   * @param basePath Base path to look for files (defaults to cwd)
   * @returns Result of the push operation
   */
  async pushTranslations(
    config: ProjectConfig,
    basePath = process.cwd()
  ): Promise<ImportResult> {
    const files = await this.findTranslationFiles(config, basePath);

    if (!files.length) {
      return { status: 'no_files' };
    }

    const sourceFiles = files.filter(file => file.language === config.sourceLocale);
    const targetFiles = files.filter(file => file.language !== config.sourceLocale);
    const allTranslations: TranslationRecord[] = [];

    for (const file of sourceFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: file.format === 'yml' ? 'yaml' : file.format,
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        })
      });
    }

    for (const file of targetFiles) {
      const fullPath = path.join(basePath, file.path);
      allTranslations.push({
        language: file.language,
        format: file.format === 'yml' ? 'yaml' : file.format,
        filename: file.path,
        content: await readFileContent(fullPath, {
          sourceLanguage: config.sourceLocale,
          currentLanguage: file.language
        })
      });
    }

    const importResult = await bulkUpdateTranslations({
      projectId: config.projectId,
      translations: allTranslations
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
        sourceImport
      } = {}
    } = finalImportResult;

    return {
      status,
      statistics,
      warnings,
      translations_url,
      sourceImport,
      files: { source: [], target: files }
    };
  }
};

/**
 * Find translation files based on configuration
 * @param config Project configuration
 * @param basePath Base path to look for files (defaults to cwd)
 * @returns Array of import file objects
 */
export async function findTranslationFiles(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportFile[]> {
  return importService.findTranslationFiles(config, basePath);
}

/**
 * Import translations from files
 * @param config Project configuration
 * @param basePath Base path to look for files (defaults to cwd)
 * @returns Result of the import operation
 */
export async function importTranslations(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportResult> {
  return importService.importTranslations(config, basePath);
}

/**
 * Push translations to the API
 * @param config Project configuration
 * @param basePath Base path to look for files (defaults to cwd)
 * @returns Result of the push operation
 */
export async function pushTranslations(
  config: ProjectConfig,
  basePath = process.cwd()
): Promise<ImportResult> {
  return importService.pushTranslations(config, basePath);
}