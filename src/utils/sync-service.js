import chalk from 'chalk';
import { configService } from './config.js';
import { getUpdates } from '../api/translations.js';
import { updateTranslationFile, deleteKeysFromTranslationFile } from './translation-updater.js';
import { findTranslationFiles } from './files.js';

const MAX_PAGES = 10;

export const syncService = {
  async checkForUpdates({ verbose = false } = {}) {
    const config = await configService.getValidProjectConfig();

    if (!config.projectId) {
      throw new Error('Project not initialized. Please run `localhero init` first.');
    }

    const since = config.lastSyncedAt || new Date(0).toISOString();

    if (verbose) {
      console.log(chalk.blue(`🔄 Checking for updates since ${since}`));
    }

    let allFiles = [];
    let deletedKeys = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages && currentPage <= MAX_PAGES) {
      const response = await getUpdates(config.projectId, { since, page: currentPage });

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
      if (verbose) {
        console.log(chalk.green('✓ All translations are up to date'));
      }
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

  async applyUpdates(updates, { verbose = false } = {}) {
    let totalUpdates = 0;
    let totalDeleted = 0;
    for (const file of updates.updates.files || []) {
      for (const lang of file.languages) {
        if (verbose) {
          console.log(chalk.blue(`Updating ${lang.code} translations in ${file.path}`));
        }

        const translations = {};
        for (const translation of lang.translations) {
          translations[translation.key] = translation.value;
          if (verbose) {
            const displayValue = translation.value.length > 100 ? `${translation.value.slice(0, 100)}…` : translation.value;
            console.log(chalk.gray(` ${translation.key} = ${displayValue}`));
          }
        }

        try {
          await updateTranslationFile(file.path, translations, lang.code);
          totalUpdates += Object.keys(translations).length;
        } catch (error) {
          console.error(chalk.yellow(`⚠️  Failed to update ${file.path}: ${error.message}`));
        }
      }
    }
    const deletedKeys = updates.updates.deleted_keys || [];
    if (deletedKeys.length > 0) {
      if (verbose) {
        console.log(chalk.blue(`\nProcessing ${deletedKeys.length} deleted keys`));
      }
      const config = await configService.getValidProjectConfig();
      const translationFiles = await findTranslationFiles(config, {
        parseContent: false,
        includeContent: false,
        extractKeys: false,
        verbose
      });

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
        } catch (error) {
          console.error(chalk.yellow(`⚠️  Failed to delete keys from ${file.path}: ${error.message}`));
        }
      }
    }

    await configService.updateLastSyncedAt();

    return { totalUpdates, totalDeleted };
  }
};