import chalk from 'chalk';
import { nanoid } from 'nanoid';
import { execSync } from 'child_process';
import { configService, type ConfigService } from '../utils/config.js';
import { findTranslationFiles } from '../utils/files.js';
import { createTranslationJob, checkJobStatus, finalizeTranslationJobs } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater/index.js';
import { checkAuth } from '../utils/auth.js';
import { fetchSettings } from '../api/settings.js';
import { localeCodesMatch } from '../utils/translation-processor.js';
import {
  filterByGitChanges,
  isGitAvailable,
  getManifestForFinalize,
  getRemovedKeysManifestForFinalize
} from '../utils/git-changes.js';
import { getCurrentBranch } from '../utils/git.js';
import {
  findMissingTranslations,
  batchKeysWithMissing,
  findMissingTranslationsByLocale,
  BatchResult,
  MissingLocaleEntry
} from '../utils/translation-utils.js';
import { autoCommitChanges } from '../utils/github.js';
import { detectTargetChanges, type TargetChangeFile } from '../utils/target-changes.js';
import { createPullRequestImport } from '../api/pull-request-imports.js';
import { processTranslationBatches } from '../utils/translation-processor.js';
import { createIgnoreMatcher, summarizeRemoved } from '../utils/ignore-keys.js';
import { logIgnoreSummary } from '../utils/ignore-keys-logging.js';
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
  changedOnly?: boolean;
  skipCommit?: boolean;
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
  settingsUtils: {
    fetchSettings: (projectId: string) => Promise<any>;
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
      sourcePath: string,
      sourceLanguage?: string,
      config?: ProjectConfig
    ) => Promise<any>;
    findMissingTranslations: (
      sourceKeys: Record<string, any>,
      targetKeys: Record<string, any>,
      localeCategories?: string[]
    ) => any;
    batchKeysWithMissing: (
      sourceFiles: OriginalTranslationFile[],
      missingByLocale: Record<string, MissingLocaleEntry>
    ) => BatchResult;
    findMissingTranslationsByLocale: (
      sourceFiles: OriginalTranslationFile[],
      targetFilesByLocale: Record<string, OriginalTranslationFile[]>,
      config: { sourceLocale: string; outputLocales: string[] },
      verbose: boolean,
      logger?: { log: (message?: any, ...optionalParams: any[]) => void },
      filterOptions?: { ignoreMatcher?: (keyName: string) => boolean }
    ) => {
      missing: Record<string, MissingLocaleEntry>;
      removed: Array<{ name: string; locale?: string }>;
    };
  };
  gitUtils: {
    autoCommitChanges: (paths: string, translationSummary?: {
      keysTranslated: number;
      languages: string[];
      viewUrl?: string;
    }) => Promise<void>;
  };
  execUtils: {
    execSync: (command: string, options?: any) => Buffer | string;
  };
}

const defaultDeps: TranslationDependencies = {
  console,
  configUtils: configService,
  authUtils: { checkAuth },
  settingsUtils: { fetchSettings },
  fileUtils: { findTranslationFiles },
  translationUtils: {
    createTranslationJob,
    checkJobStatus,
    updateTranslationFile,
    findMissingTranslations,
    batchKeysWithMissing,
    findMissingTranslationsByLocale
  },
  gitUtils: { autoCommitChanges },
  execUtils: { execSync }
};

async function fetchLocalePluralCategories(
  projectId: string,
  outputLocales: string[],
  settingsUtils: { fetchSettings: (projectId: string) => Promise<any> },
  verbose: boolean | undefined,
  logger: { log: (message?: any, ...optionalParams: any[]) => void }
): Promise<Record<string, string[]>> {
  const CLDR_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const map: Record<string, string[]> = {};
  try {
    const { settings } = await settingsUtils.fetchSettings(projectId);
    for (const lang of settings?.target_languages ?? []) {
      const categories = lang.plural_categories;
      // Only trust a non-empty CLDR subset that includes `other`; anything else
      // (empty, malformed, partial-rollout) falls back to exact-name matching.
      const valid = Array.isArray(categories) &&
        categories.length > 0 &&
        categories.includes('other') &&
        categories.every((c: string) => CLDR_CATEGORIES.includes(c));
      if (!valid) continue;

      // Key by the CONFIG spelling so lookup-by-outputLocale matches even when
      // the API returns a different separator/case (config zh_cn vs API zh-CN).
      // Assign to every config locale that folds to this code so a duplicated
      // spelling (e.g. both zh_cn and zh-CN) is handled deterministically.
      const matches = outputLocales.filter((l) => localeCodesMatch(l, lang.code));
      for (const configCode of (matches.length > 0 ? matches : [lang.code])) {
        map[configCode] = categories;
      }
    }
  } catch {
    if (verbose) {
      logger.log(chalk.gray('ℹ Could not fetch locale plural categories; using exact key matching.'));
    }
  }
  return map;
}

export async function translate(options: TranslationOptions = {}, deps: TranslationDependencies = defaultDeps): Promise<void> {
  const { console, configUtils, authUtils, settingsUtils, fileUtils, translationUtils, gitUtils, execUtils } = deps;
  const { verbose } = options;

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.error(chalk.red('\n✖ Your API key is invalid. Please run `npx @localheroai/cli login` to authenticate.\n'));
    process.exit(1);
    return;
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

  // Fetch per-locale CLDR plural categories so missing-detection doesn't demand a
  // `.one` form from other-only locales (#432). Best-effort: an older backend that
  // omits the field leaves the map empty, falling back to exact-name matching.
  config.localePluralCategories = await fetchLocalePluralCategories(
    config.projectId,
    config.outputLocales,
    settingsUtils,
    verbose,
    console
  );

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
    return;
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
    return;
  }

  if (verbose) {
    console.log(chalk.blue(`ℹ Found ${sourceFiles.length} source files for locale ${config.sourceLocale}`));
  }

  const projectId = config.projectId;

  async function sendPullRequestImport(
    targetChanges: TargetChangeFile[],
    jobGroupId: string
  ): Promise<void> {
    if (targetChanges.length === 0) return;

    try {
      const branch = await getCurrentBranch();
      if (!branch) return;

      const importResult = await createPullRequestImport({
        projectId,
        branch,
        jobGroupId,
        files: targetChanges
      });

      if (importResult.imported_count > 0) {
        console.log(`» Sent ${importResult.imported_count} translation value${importResult.imported_count === 1 ? '' : 's'} from this PR for review`);
      }
      for (const skipped of importResult.skipped) {
        console.log(chalk.yellow(`  Skipped ${skipped.path}: ${skipped.key} (${skipped.reason})`));
      }
    } catch (err) {
      if (verbose) {
        console.log(chalk.dim(`Translation ingestion skipped: ${(err as Error).message}`));
      }
    }
  }

  async function sendFinalize(
    manifest: Record<string, any>,
    jobGroupId: string,
    removedManifest: Record<string, any> | null
  ): Promise<void> {
    try {
      const branch = await getCurrentBranch();
      await finalizeTranslationJobs({
        projectId,
        jobGroupId,
        prKeyManifest: manifest,
        removedKeyManifest: removedManifest,
        commitSha: process.env.GITHUB_SHA,
        branch: branch || undefined
      });
      if (verbose) {
        console.log(chalk.dim('Sent key manifest for PR reconciliation'));
      }
    } catch (err) {
      if (verbose) {
        console.log(chalk.dim(`Finalize call skipped: ${(err as Error).message}`));
      }
    }
  }

  if (options.changedOnly && !isGitAvailable()) {
    console.error(chalk.red('\n✖ Git is required for the --changed-only flag but is not available.\n'));
    console.error(chalk.yellow('Please ensure you are in a git repository.\n'));
    process.exit(1);
    return;
  }

  const ignoreMatcher = createIgnoreMatcher(config.translationFiles?.ignoreKeys ?? []);

  const findResult = translationUtils.findMissingTranslationsByLocale(
    sourceFiles,
    targetFilesByLocale,
    config,
    !!verbose,
    console,
    { ignoreMatcher }
  );
  let missingByLocale = findResult.missing;

  const ignoreSummary = summarizeRemoved(findResult.removed, config.translationFiles?.ignoreKeys ?? []);
  if (verbose && (ignoreSummary.totalKeysIgnored > 0 || ignoreSummary.zeroMatchPatterns.length > 0)) {
    logIgnoreSummary(ignoreSummary, console);
  }

  // Capture the full manifest BEFORE filtering down to missing-only keys.
  // This is the complete snapshot of "what differs from main" for this push.
  let manifest: Record<string, any> | null = null;
  let removedManifest: Record<string, any> | null = null;
  let targetChanges: TargetChangeFile[] = [];
  if (options.changedOnly) {
    manifest = getManifestForFinalize(sourceFiles, config, !!verbose);
    removedManifest = getRemovedKeysManifestForFinalize(sourceFiles, config, !!verbose);
    targetChanges = detectTargetChanges(sourceFiles, targetFilesByLocale, config, !!verbose) ?? [];

    const filtered = filterByGitChanges(
      sourceFiles,
      missingByLocale,
      config,
      !!verbose
    );

    if (filtered !== null) {
      if (Object.keys(filtered).length === 0) {
        const jobGroupId = nanoid();
        if (manifest !== null) {
          await sendFinalize(manifest, jobGroupId, removedManifest);
        }
        await sendPullRequestImport(targetChanges, jobGroupId);
        console.log(chalk.green('✓ All changed keys are already translated'));
        return;
      }
      missingByLocale = filtered;
    } else {
      console.error(chalk.red('\n✖ Could not determine changed keys (e.g., base branch not found).\n'));
      console.error(chalk.yellow('Run with --verbose for more details.\n'));
      process.exit(1);
      return;
    }
  }

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
    return;
  }

  try {
    const jobGroupId = nanoid();
    const translationResult: TranslationResult = await processTranslationBatches(
      batches,
      missingByLocale as any,
      config,
      !!verbose,
      { console, translationUtils },
      jobGroupId
    );

    if (manifest !== null) {
      await sendFinalize(manifest, jobGroupId, removedManifest);
    }

    await sendPullRequestImport(targetChanges, jobGroupId);

    const translatedLocales = new Set(translationResult.languages);
    const onlySkipped = translationResult.skippedLanguages.filter((locale) => !translatedLocales.has(locale));
    if (onlySkipped.length > 0) {
      console.log(chalk.blue(`ℹ Auto-translation off for ${onlySkipped.join(', ')} (project setting)`));
    }

    await configUtils.updateLastSyncedAt();

    if (translationResult.failedLanguages.length > 0) {
      console.error(chalk.red('⚠️  Some translations failed!'));
      console.error(chalk.red(`» ${translationResult.failedLanguages.length} language(s) failed: ${translationResult.failedLanguages.join(', ')}`));
      if (translationResult.uniqueKeysTranslated.size > 0) {
        console.log(`» Successfully updated ${translationResult.uniqueKeysTranslated.size} keys in ${translationResult.totalLanguages} languages`);
      }
    } else {
      console.log(chalk.green('✓ Translations complete!'));
      if (translationResult.uniqueKeysTranslated.size > 0) {
        console.log(`» Updated ${translationResult.uniqueKeysTranslated.size} keys in ${translationResult.totalLanguages} languages`);
      }
    }

    if (translationResult.uniqueKeysTranslated.size > 0) {
      if (translationResult.jobGroupShortUrl) {
        console.log(`» View results at: ${translationResult.jobGroupShortUrl}`);
      } else if (translationResult.resultsBaseUrl && translationResult.allJobIds.length > 0) {
        const jobIdsParam = translationResult.allJobIds.join(',');
        console.log(`» View results at: ${translationResult.resultsBaseUrl}?job_ids=${jobIdsParam}`);
      }

      if (config.postTranslateCommand) {
        try {
          if (verbose) {
            console.log(chalk.blue(`\nℹ Executing postTranslateCommand: ${config.postTranslateCommand}`));
          }
          execUtils.execSync(config.postTranslateCommand, { stdio: verbose ? 'inherit' : 'pipe' });
          if (verbose) {
            console.log(chalk.green('✓ postTranslateCommand completed successfully'));
          }
        } catch (error) {
          const err = error as Error;
          console.warn(chalk.yellow(`\nℹ postTranslateCommand failed: ${err.message}`));
        }
      }

      if (!options.skipCommit) {
        try {
          await gitUtils.autoCommitChanges(config.translationFiles.paths.join(' '), {
            keysTranslated: translationResult.uniqueKeysTranslated.size,
            languages: translationResult.languages,
            viewUrl: translationResult.jobGroupShortUrl || translationResult.resultsBaseUrl || undefined
          });
        } catch (error) {
          const err = error as Error;
          console.warn(chalk.yellow(`\nℹ Could not auto-commit changes: ${err.message}`));
        }
      }
    }

    if (translationResult.failedLanguages.length > 0 && translationResult.uniqueKeysTranslated.size === 0) {
      process.exit(1);
      return;
    }
  } catch (error) {
    if (error instanceof ApiResponseError) {
      console.error(chalk.red(`\n✖ API error processing translation jobs: ${error.cliErrorMessage || error.message}`));
      if (error.details) {
        console.error(chalk.red(`  ${error.details}`));
      }
    } else {
      const err = error as Error;

      console.error(chalk.red(`\n✖ Error processing translation jobs: ${err.message}`));

      if (err.stack) {
        console.error(chalk.dim(err.stack));
      }
    }
    process.exit(1);
    return;
  }
}
