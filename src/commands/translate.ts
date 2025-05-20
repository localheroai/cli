import chalk from 'chalk';
import { configService, type ConfigService } from '../utils/config.js';
import { findTranslationFiles } from '../utils/files.js';
import { createTranslationJob, checkJobStatus } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater/index.js';
import { checkAuth } from '../utils/auth.js';
import {
  findMissingTranslations,
  batchKeysWithMissing,
  findMissingTranslationsByLocale,
  BatchResult,
  MissingLocaleEntry
} from '../utils/translation-utils.js';
import { syncService, type SyncService } from '../utils/sync-service.js';
import { autoCommitChanges } from '../utils/github.js';
import { processTranslationBatches } from '../utils/translation-processor.js';
import type {
  TranslationResult
} from '../utils/translation-processor.js';
import type {
  ProjectConfig,
  TranslationConfig,
  TranslationFileOptions,
  TranslationFile as OriginalTranslationFile,
  TranslationFilesResult as OriginalTranslationFilesResult
} from '../types/index.js';
import { ApiResponseError } from '../types/index.js';

export interface TranslationOptions {
  verbose?: boolean;
  commit?: boolean;
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

interface TranslationDependencies {
  console: {
    log: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
    warn: (message?: any, ...optionalParams: any[]) => void;
  };
  configUtils: Pick<ConfigService, 'getProjectConfig' | 'updateLastSyncedAt'>;
  authUtils: {
    checkAuth: () => Promise<boolean>;
  };
  fileUtils: {
    findTranslationFiles: (
      config: TranslationConfig,
      options?: TranslationFileOptions
    ) => Promise<OriginalTranslationFile[] | OriginalTranslationFilesResult>;
  };
  translationUtils: {
    createTranslationJob: (jobRequest: any) => Promise<any>;
    checkJobStatus: (jobId: string, includeTranslations?: boolean) => Promise<any>;
    updateTranslationFile: (
      targetPath: string,
      translations: any,
      languageCode: string,
      sourcePath: string
    ) => Promise<any>;
    findMissingTranslations: (sourceFile: any, targetFiles: any[], config: ProjectConfig) => any;
    batchKeysWithMissing: (
      sourceFiles: OriginalTranslationFile[],
      missingByLocale: Record<string, MissingLocaleEntry>
    ) => BatchResult;
    findMissingTranslationsByLocale: (
      sourceFiles: OriginalTranslationFile[],
      targetFilesByLocale: Record<string, OriginalTranslationFile[]>,
      config: { sourceLocale: string; outputLocales: string[] },
      verbose: boolean,
      logger?: { log: (message?: any, ...optionalParams: any[]) => void }
    ) => Record<string, MissingLocaleEntry>;
  };
  syncService: SyncService;
  gitUtils: {
    autoCommitChanges: (paths: string) => void;
  };
}

const defaultDeps: TranslationDependencies = {
  console,
  configUtils: configService,
  authUtils: { checkAuth },
  fileUtils: { findTranslationFiles },
  translationUtils: {
    createTranslationJob,
    checkJobStatus,
    updateTranslationFile,
    findMissingTranslations,
    batchKeysWithMissing,
    findMissingTranslationsByLocale
  },
  syncService,
  gitUtils: { autoCommitChanges }
};

export async function translate(options: TranslationOptions = {}, deps: TranslationDependencies = defaultDeps): Promise<void> {
  const { console, configUtils, authUtils, fileUtils, translationUtils, syncService, gitUtils } = deps;
  const { verbose } = options;

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.error(chalk.red('\n✖ Your API key is invalid. Please run `npx @localheroai/cli login` to authenticate.\n'));
    process.exit(1);
  }

  const config = await configUtils.getProjectConfig();
  if (!config) {
    console.error(chalk.red('\n✖ No configuration found. Please run `npx @localheroai/cli init` first.\n'));
    process.exit(1);
    return;
  }

  if (!config.translationFiles?.paths) {
    console.error(chalk.red('\n✖ Invalid configuration: missing translationFiles.paths. Please run `npx @localheroai/cli init` to set up your configuration.\n'));
    process.exit(1);
    return;
  }

  const { hasUpdates, updates } = await syncService.checkForUpdates(verbose);
  if (hasUpdates && updates) {
    await syncService.applyUpdates(updates, verbose);
  }

  if (verbose) {
    console.log(chalk.blue('\nℹ Using configuration:'));
    console.log(chalk.gray(`  Project ID: ${config.projectId}`));
    console.log(chalk.gray(`  Source locale: ${config.sourceLocale}`));
    console.log(chalk.gray(`  Output locales: ${config.outputLocales.join(', ')}`));
    console.log(chalk.gray(`  Translation files: ${config.translationFiles.paths.join(', ')}`));
  }

  const result = await fileUtils.findTranslationFiles(config, { verbose, returnFullResult: true });
  const { sourceFiles, targetFilesByLocale, allFiles } = result as TranslationFilesResult;

  if (!allFiles || allFiles.length === 0) {
    console.error(chalk.red('\n✖ No translation files found in the specified paths.\n'));
    process.exit(1);
  }

  if (verbose) {
    console.log(chalk.blue(`\nℹ Found ${allFiles.length} translation files`));
  }

  if (sourceFiles.length === 0) {
    console.error(chalk.red(`\n✖ No source files found for locale ${config.sourceLocale}\n`));
    console.error(chalk.yellow('This could be due to one of the following issues:'));
    console.error(chalk.yellow(`  1. No translation files with the source locale "${config.sourceLocale}" exist in the configured paths`));
    console.error(chalk.yellow('  2. The locale identifiers in your filenames don\'t match the expected pattern'));
    console.error(chalk.yellow('  3. There was an error parsing one or more files (check for syntax errors in YAML or JSON)\n'));
    console.error(chalk.yellow('Try running with the --verbose flag for more detailed information.\n'));
    process.exit(1);
  }

  if (verbose) {
    console.log(chalk.blue(`ℹ Found ${sourceFiles.length} source files for locale ${config.sourceLocale}`));
  }

  const missingByLocale = translationUtils.findMissingTranslationsByLocale(
    sourceFiles,
    targetFilesByLocale,
    config,
    !!verbose,
    console
  );

  interface LocaleSummary {
    keyCount: number;
    fileCount: number;
  }

  const missingLocalesSummary: Record<string, LocaleSummary> = {};
  Object.values(missingByLocale).forEach((data: MissingLocaleEntry) => {
    const { locale, keyCount = 0 } = data;
    if (!missingLocalesSummary[locale]) {
      missingLocalesSummary[locale] = { keyCount: 0, fileCount: 0 };
    }
    missingLocalesSummary[locale].keyCount += keyCount;
    missingLocalesSummary[locale].fileCount += 1;
  });

  const missingLocales = Object.keys(missingLocalesSummary);
  if (missingLocales.length === 0) {
    console.log(chalk.green('✓ All translations are up to date'));
    return;
  }

  if (verbose) {
    console.log(chalk.blue('\nℹ Missing translations:'));
    for (const [locale, data] of Object.entries(missingLocalesSummary)) {
      console.log(chalk.gray(`  ${locale}: ${data.keyCount} keys in ${data.fileCount} files`));
    }
  }

  const { batches, errors } = translationUtils.batchKeysWithMissing(sourceFiles, missingByLocale);

  if (errors.length > 0) {
    console.error(chalk.red('\n✖ Errors occurred while preparing translation jobs:'));
    for (const error of errors) {
      console.error(chalk.red(`  ${error.message}`));
    }
    process.exit(1);
  }

  try {
    const translationResult: TranslationResult = await processTranslationBatches(
      batches,
      missingByLocale as any,
      config,
      !!verbose,
      { console, translationUtils }
    );

    await configUtils.updateLastSyncedAt();

    console.log(chalk.green('✓ Translations complete!'));
    if (translationResult.uniqueKeysTranslated.size > 0) {
      console.log(`» Updated ${translationResult.uniqueKeysTranslated.size} keys in ${translationResult.totalLanguages} languages`);
    }

    if (translationResult.uniqueKeysTranslated.size > 0) {
      try {
        gitUtils.autoCommitChanges(config.translationFiles.paths.join(' '));
      } catch (error) {
        const err = error as Error;
        console.warn(chalk.yellow(`\nℹ Could not auto-commit changes: ${err.message}`));
      }
    }

    if (translationResult.resultsBaseUrl && translationResult.allJobIds.length > 0 && translationResult.uniqueKeysTranslated.size) {
      const jobIdsParam = translationResult.allJobIds.join(',');
      console.log(`» View results at: ${translationResult.resultsBaseUrl}?job_ids=${jobIdsParam}`);
    }
  } catch (error) {
    if (error instanceof ApiResponseError) {
      console.error(chalk.red(`\n✖ API error processing translation jobs: ${error.cliErrorMessage || error.message}`));
      if (error.details) {
        console.error(chalk.red(`  ${error.details}`));
      }
    } else {
      // Handle any other type of error
      const err = error as Error;
      console.error(chalk.red(`\n✖ Error processing translation jobs: ${err.message}`));
      if (err.stack) {
        const stackLines = err.stack.split('\n').slice(1);
        if (stackLines && stackLines.length > 0) {
          console.error(chalk.dim('\nStack trace:'));
          stackLines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith(' at ')) {
              console.error(chalk.dim(trimmed));
            }
          });
        }
      }
    }
    process.exit(1);
  }
}