import chalk from 'chalk';
import { configService } from '../utils/config.js';
import { findTranslationFiles, parseFile, flattenTranslations } from '../utils/files.js';
import { createTranslationJob, checkJobStatus } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater.js';
import { checkAuth } from '../utils/auth.js';
import { findMissingTranslations, batchKeysWithMissing, processLocaleTranslations } from '../utils/translation-utils.js';
import { syncService } from '../utils/sync-service.js';

const BATCH_SIZE = 50;

const defaultDeps = {
  console,
  configUtils: configService,
  authUtils: { checkAuth },
  fileUtils: { findTranslationFiles },
  translationUtils: {
    createTranslationJob,
    checkJobStatus,
    updateTranslationFile,
    findMissingTranslations,
    batchKeysWithMissing
  },
  syncService
};

export async function translate(options = {}, deps = defaultDeps) {
  const { console, configUtils, authUtils, fileUtils, translationUtils, syncService } = deps;
  const { verbose } = options;

  // Check authentication first
  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.error(chalk.red('\n✖ Your API key is invalid. Please run `npx @localheroai/cli login` to authenticate.\n'));
    process.exit(1);
  }

  // Load configuration
  const config = await configUtils.getProjectConfig();
  if (!config) {
    console.error(chalk.red('\n✖ No configuration found. Please run `npx @localheroai/cli init` first.\n'));
    process.exit(1);
    return;
  }

  // Validate required config properties
  if (!config.translationFiles?.paths) {
    console.error(chalk.red('\n✖ Invalid configuration: missing translationFiles.paths. Please run `npx @localheroai/cli init` to set up your configuration.\n'));
    process.exit(1);
    return;
  }

  // Check and apply any pending updates first
  const { hasUpdates, updates } = await syncService.checkForUpdates({ verbose });
  if (hasUpdates) {
    await syncService.applyUpdates(updates, { verbose });
  }

  if (verbose) {
    console.log(chalk.blue('\nℹ Using configuration:'));
    console.log(chalk.gray(`  Project ID: ${config.projectId}`));
    console.log(chalk.gray(`  Source locale: ${config.sourceLocale}`));
    console.log(chalk.gray(`  Output locales: ${config.outputLocales.join(', ')}`));
    console.log(chalk.gray(`  Translation files: ${config.translationFiles.paths.join(', ')}`));
  }

  // Find translation files
  const result = await fileUtils.findTranslationFiles(config, { verbose, returnFullResult: true });
  const { sourceFiles, targetFilesByLocale, allFiles } = result;

  if (!allFiles || allFiles.length === 0) {
    console.error(chalk.red('\n✖ No translation files found in the specified paths.\n'));
    process.exit(1);
  }

  if (verbose) {
    console.log(chalk.blue(`\nℹ Found ${allFiles.length} translation files`));
  }

  // Process source files
  if (sourceFiles.length === 0) {
    console.error(chalk.red(`\n✖ No source files found for locale ${config.sourceLocale}\n`));
    process.exit(1);
  }

  if (verbose) {
    console.log(chalk.blue(`ℹ Found ${sourceFiles.length} source files for locale ${config.sourceLocale}`));
  }

  const missingByLocale = {};

  // Process each source file
  for (const sourceFile of sourceFiles) {
    const sourceContentRaw = Buffer.from(sourceFile.content, 'base64').toString();
    const sourceContent = parseFile(sourceContentRaw, sourceFile.format);
    const sourceKeys = flattenTranslations(sourceContent[config.sourceLocale] || sourceContent);

    // Process each target locale
    for (const targetLocale of config.outputLocales) {
      const targetFiles = targetFilesByLocale[targetLocale] || [];
      const result = processLocaleTranslations(sourceKeys, targetLocale, targetFiles, sourceFile, config.sourceLocale);

      if (Object.keys(result.missingKeys).length > 0) {
        if (!missingByLocale[targetLocale]) {
          missingByLocale[targetLocale] = {
            path: sourceFile.path,
            targetPath: result.targetPath,
            keys: {},
            keyCount: 0
          };
        }

        missingByLocale[targetLocale].keys = {
          ...missingByLocale[targetLocale].keys,
          ...result.missingKeys
        };
        missingByLocale[targetLocale].keyCount += Object.keys(result.missingKeys).length;
      }

      if (verbose && Object.keys(result.skippedKeys).length > 0) {
        console.log(chalk.yellow(`\nℹ Skipped ${Object.keys(result.skippedKeys).length} keys marked as WIP in ${sourceFile.path}`));
      }
    }
  }

  // Process missing translations
  const missingLocales = Object.keys(missingByLocale);
  if (missingLocales.length === 0) {
    console.log(chalk.green('✓ All translations are up to date!'));
    return;
  }

  if (verbose) {
    console.log(chalk.blue('\nℹ Missing translations:'));
    for (const [locale, data] of Object.entries(missingByLocale)) {
      console.log(chalk.gray(`  ${locale}: ${data.keyCount} keys`));
    }
  }

  // Create translation jobs
  const { batches, errors } = translationUtils.batchKeysWithMissing(sourceFiles, missingByLocale, BATCH_SIZE);

  if (errors.length > 0) {
    console.error(chalk.red('\n✖ Errors occurred while preparing translation jobs:'));
    for (const error of errors) {
      console.error(chalk.red(`  ${error.message}`));
    }
    process.exit(1);
  }

  let totalTranslated = 0;
  let totalLanguages = 0;
  const processedLocales = new Set();
  const allJobIds = [];
  let resultsBaseUrl = null;

  for (const batch of batches) {
    const jobRequest = {
      projectId: config.projectId,
      sourceFiles: batch.files,
      targetLocales: batch.locales
    };

    try {
      const response = await translationUtils.createTranslationJob(jobRequest);
      const { jobs } = response;

      // Collect all job IDs
      const batchJobIds = jobs.map(job => job.id);
      allJobIds.push(...batchJobIds);

      const pendingJobs = new Set(batchJobIds);

      while (pendingJobs.size > 0) {
        const jobPromises = Array.from(pendingJobs).map(async jobId => {
          if (verbose) {
            console.log(chalk.blue(`\nℹ Checking job ${jobId}`));
          }

          let status;
          let retries = 0;
          const MAX_WAIT_MINUTES = 10;
          const startTime = Date.now();

          do {
            status = await translationUtils.checkJobStatus(jobId, true);

            if (status.status === 'failed') {
              throw new Error(`Translation job failed: ${status.error_details || 'Unknown error'}`);
            }

            if (status.status === 'pending' || status.status === 'processing') {
              const elapsed = Math.floor((Date.now() - startTime) / 1000);
              if (elapsed > MAX_WAIT_MINUTES * 60) {
                throw new Error(`Translation timed out after ${MAX_WAIT_MINUTES} minutes`);
              }

              const waitSeconds = Math.min(2 ** retries, 30);
              if (verbose) {
                console.log(chalk.blue(`  Job ${jobId} is ${status.status}, checking again in ${waitSeconds}s...`));
              }
              await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
              retries = Math.min(retries + 1, 5);
              return { jobId, status: 'pending' };
            }

            if (status.status === 'completed' && status.translations?.data && status.language?.code) {
              // Store the results_url if available and not already set
              if (status.results_url && !resultsBaseUrl) {
                resultsBaseUrl = status.results_url.split('?')[0];
              }

              const languageCode = status.language.code;
              // Only process each locale once
              if (!processedLocales.has(languageCode)) {
                const targetPath = missingByLocale[languageCode].targetPath;
                if (verbose) {
                  console.log(chalk.blue(`  Updating translations for ${languageCode} in ${targetPath}`));
                }
                await translationUtils.updateTranslationFile(targetPath, status.translations.data, languageCode);
                totalTranslated += missingByLocale[languageCode].keyCount;
                totalLanguages++;
                processedLocales.add(languageCode);
              }
              return { jobId, status: 'completed' };
            }

            return { jobId, status: status.status };
          } while (status.status === 'pending' || status.status === 'processing');
        });

        const results = await Promise.all(jobPromises);
        results.forEach(result => {
          if (result.status === 'completed') {
            pendingJobs.delete(result.jobId);
          }
        });

        if (pendingJobs.size > 0) {
          // Wait a bit before checking remaining jobs again
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      console.error(chalk.red(`\n✖ Error processing translation jobs: ${error.message}\n`));
      process.exit(1);
    }
  }

  await configUtils.updateLastSyncedAt();

  console.log(chalk.green('✓ Translations complete!'));
  console.log(`Updated ${totalTranslated} keys in ${totalLanguages} languages`);

  if (resultsBaseUrl && allJobIds.length > 0) {
    const jobIdsParam = allJobIds.join(',');
    console.log(`View job results at: ${resultsBaseUrl}?job_ids=${jobIdsParam}`);
  }
}
