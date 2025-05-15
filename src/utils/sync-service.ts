import chalk from 'chalk';
import { configService } from './config.js';
import { getUpdates, GetUpdatesParams } from '../api/translations.js';
import { updateTranslationFile, deleteKeysFromTranslationFile } from './translation-updater/index.js';
import { findTranslationFiles } from './files.js';
import path from 'path';
import { TranslationFile, TranslationFilesResult } from '../types/index.js';

const MAX_PAGES = 50;

interface LanguageUpdate {
  code: string;
  translations: Array<{
    key: string;
    value: string;
  }>;
}

interface FileUpdate {
  path: string;
  languages: LanguageUpdate[];
}

interface DeletedKey {
  name: string;
  [key: string]: any;
}

interface Pagination {
  current_page: number;
  total_pages: number;
  total_count: number;
}

interface ApiUpdateResponse {
  updates: {
    updated_keys: FileUpdate[];
    deleted_keys: DeletedKey[];
  };
  pagination: Pagination;
}

export interface Updates {
  updates: {
    files: FileUpdate[];
    deleted_keys: DeletedKey[];
  };
}

export interface CheckForUpdatesResult {
  hasUpdates: boolean;
  updates?: Updates;
}

interface ApplyUpdatesResult {
  totalUpdates: number;
  totalDeleted: number;
}

export interface SyncService {
  checkForUpdates(verbose?: boolean): Promise<CheckForUpdatesResult>;
  applyUpdates(updates: Updates, verbose?: boolean): Promise<ApplyUpdatesResult>;
}

export const syncService: SyncService = {
  /**
   * Check for updates since the last sync
   * @param verbose Whether to show verbose output
   * @returns Result with updates if any are available
   */
  async checkForUpdates(verbose = false): Promise<CheckForUpdatesResult> {
    const config = await configService.getValidProjectConfig();

    if (!config.projectId) {
      throw new Error('Project not initialized. Please run `localhero init` first.');
    }

    const since = config.lastSyncedAt || new Date(0).toISOString();

    if (verbose) {
      console.log(chalk.blue(`Checking for updates since ${since}`));
    }

    let allFiles: FileUpdate[] = [];
    let deletedKeys: DeletedKey[] = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages && currentPage <= MAX_PAGES) {
      const params: GetUpdatesParams = { since, page: currentPage };
      const response = await getUpdates(config.projectId, params) as unknown as ApiUpdateResponse;

      if (response.updates?.updated_keys?.length) {
        allFiles = allFiles.concat(response.updates.updated_keys);
      }

      if (response.updates?.deleted_keys?.length) {
        deletedKeys = deletedKeys.concat(response.updates.deleted_keys);
      }

      if (response.pagination) {
        const { current_page, total_pages } = response.pagination;
        hasMorePages = current_page < total_pages;
        currentPage++;

        if (verbose && hasMorePages) {
          if (total_pages > MAX_PAGES) {
            console.log(chalk.yellow(`  ⚠️  Limiting to ${MAX_PAGES} pages out of ${total_pages} total`));
          } else {
            console.log(chalk.gray(`  Fetching page ${currentPage} of ${total_pages}`));
          }
        }
      } else {
        hasMorePages = false;
      }
    }

    if (!allFiles.length && !deletedKeys.length) {
      return { hasUpdates: false };
    }

    return {
      hasUpdates: true,
      updates: {
        updates: {
          files: allFiles,
          deleted_keys: deletedKeys
        }
      }
    };
  },

  /**
   * Apply updates to translation files
   * @param updates Updates to apply
   * @param verbose Whether to show verbose output
   * @returns Result with the number of updates and deletes
   */
  async applyUpdates(updates: Updates, verbose = false): Promise<ApplyUpdatesResult> {
    let totalUpdates = 0;
    let totalDeleted = 0;

    // First, find all source files
    const config = await configService.getValidProjectConfig();
    const result = await findTranslationFiles(config, {
      parseContent: false,
      includeContent: false,
      extractKeys: false,
      returnFullResult: true,
      verbose
    }) as TranslationFilesResult;

    const sourceFiles = result.sourceFiles;

    // Create a map of source files by path
    const sourceFilesByPath: Record<string, string> = {};
    for (const sourceFile of sourceFiles) {
      const dirName = path.dirname(sourceFile.path);
      sourceFilesByPath[dirName] = sourceFile.path;
    }

    for (const file of updates.updates.files || []) {
      // Find the corresponding source file
      const dirName = path.dirname(file.path);
      const sourceFilePath = sourceFilesByPath[dirName];

      for (const lang of file.languages) {
        if (verbose) {
          console.log(chalk.blue(`Updating ${lang.code} translations in ${file.path}`));
        }

        const translations: Record<string, string> = {};
        for (const translation of lang.translations) {
          translations[translation.key] = translation.value;
          if (verbose) {
            const displayValue = translation.value.length > 100 ? `${translation.value.slice(0, 100)}…` : translation.value;
            console.log(chalk.gray(` ${translation.key} = ${displayValue}`));
          }
        }

        try {
          await updateTranslationFile(file.path, translations, lang.code, sourceFilePath);
          totalUpdates += Object.keys(translations).length;
        } catch (error: any) {
          console.error(chalk.yellow(`⚠️  Failed to update ${file.path}: ${error.message}`));
        }
      }
    }

    const deletedKeys = updates.updates.deleted_keys || [];
    if (deletedKeys.length > 0) {
      if (verbose) {
        console.log(chalk.blue(`\nProcessing ${deletedKeys.length} deleted keys`));
      }
      const translationFiles = await findTranslationFiles(config, {
        parseContent: false,
        includeContent: false,
        extractKeys: false,
        verbose
      }) as TranslationFile[];

      if (verbose) {
        console.log(chalk.blue(`Found ${translationFiles.length} translation files to check for deleted keys`));
      }
      const keysToDelete = deletedKeys.map(key => key.name);
      for (const file of translationFiles) {
        try {
          if (verbose) {
            console.log(chalk.blue(`Checking for deleted keys in ${file.path} (${file.locale})`));
          }

          const deletedFromFile = await deleteKeysFromTranslationFile(file.path, keysToDelete, file.locale);

          if (deletedFromFile.length > 0) {
            totalDeleted += deletedFromFile.length;

            if (verbose) {
              console.log(chalk.green(`✓ Deleted ${deletedFromFile.length} keys from ${file.path}`));
              for (const key of deletedFromFile) {
                console.log(chalk.gray(` - ${key}`));
              }
            }
          } else if (verbose) {
            console.log(chalk.gray(`  No keys to delete in ${file.path}`));
          }
        } catch (error: any) {
          console.error(chalk.yellow(`⚠️  Failed to delete keys from ${file.path}: ${error.message}`));
        }
      }
    }

    await configService.updateLastSyncedAt();

    return { totalUpdates, totalDeleted };
  }
};