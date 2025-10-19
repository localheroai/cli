import chalk from 'chalk';
import { ProjectConfig } from '../types/index.js';
import { Spinner } from './spinner.js';

/**
 * Types for translation processing
 */
export interface TranslationStats {
  totalLanguages: number;
  languages: Set<string>;
  resultsBaseUrl: string | null;
  jobGroupShortUrl: string | null;
  failedLanguages: Set<string>;
}

export interface TranslationJob {
  id: string;
  language?: {
    code: string;
  };
}

export interface TranslationJobResponse {
  jobs: TranslationJob[];
  job_group?: {
    id: string;
    short_url: string;
  };
}

export interface JobSourceInfo {
  sourceFilePath: string;
  locale: string;
}

export interface JobSourceMapping {
  [jobId: string]: JobSourceInfo;
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed';
  data?: any;
}

export interface TranslationBatch {
  sourceFilePath: string;
  sourceFile: {
    path: string;
    format: string;
    content: string;
  };
  localeEntries: string[];
  locales: string[];
}


export interface MissingTranslationEntry {
  locale: string;
  path: string;
  targetPath: string;
  keys: Record<string, any>;
  keyCount: number;
}

export interface MissingByLocale {
  [key: string]: MissingTranslationEntry;
}

export interface TranslationDependencies {
  console: {
    log: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
    warn: (message?: any, ...optionalParams: any[]) => void;
  };
  translationUtils: {
    createTranslationJob: (jobRequest: any) => Promise<TranslationJobResponse>;
    checkJobStatus: (jobId: string, includeTranslations?: boolean) => Promise<any>;
    updateTranslationFile: (targetPath: string, translations: any, languageCode: string, sourcePath: string, sourceLanguage?: string, config?: ProjectConfig) => Promise<any>;
  };
}

export interface TranslationResult {
  totalLanguages: number;
  languages: string[];
  allJobIds: string[];
  resultsBaseUrl: string | null;
  jobGroupShortUrl: string | null;
  uniqueKeysTranslated: Set<string>;
  failedLanguages: string[];
}

export const MAX_JOB_STATUS_CHECK_ATTEMPTS = 35;

/**
 * Creates a job request object for a batch of translations
 *
 * @param batch - The batch to create a job for
 * @param missingByLocale - Missing translations by locale and file
 * @param config - Project configuration
 * @returns The job request object
 */
function createJobRequest(
  batch: TranslationBatch,
  missingByLocale: MissingByLocale,
  config: ProjectConfig,
  jobGroupId?: string
): any {
  const targetPaths: Record<string, string> = {};
  batch.localeEntries.forEach(localeSourceKey => {
    const entry = missingByLocale[localeSourceKey];
    targetPaths[entry.locale] = entry.targetPath;
  });

  const request: any = {
    projectId: config.projectId,
    sourceFiles: [batch.sourceFile],
    targetLocales: batch.locales,
    targetPaths
  };

  if (jobGroupId) {
    request.jobGroupId = jobGroupId;
  }

  return request;
}

/**
 * Creates a mapping of job IDs to source files and locales
 *
 * @param jobs - Array of job objects from the API response
 * @param sourceFilePath - Path to the source file
 * @returns Mapping of job IDs to source information
 */
function createJobSourceMapping(
  jobs: TranslationJob[],
  sourceFilePath: string
): JobSourceMapping {
  const jobSourceMapping: JobSourceMapping = {};
  jobs.forEach(job => {
    jobSourceMapping[job.id] = {
      sourceFilePath,
      locale: job.language?.code || ''
    };
  });
  return jobSourceMapping;
}

/**
 * Monitors a job's status until completion
 *
 * @param jobId - The ID of the job to monitor
 * @param verbose - Whether to show verbose output
 * @param translationUtils - Translation utilities
 * @param console - Console for logging
 * @returns The job status when completed
 * @throws Error If the job fails or times out
 */
async function monitorJobStatus(
  jobId: string,
  verbose: boolean,
  translationUtils: TranslationDependencies['translationUtils'],
  console: TranslationDependencies['console']
): Promise<JobStatus> {
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
        let progressMsg = `  Job ${jobId} is ${status.status}`;

        // Add progress information if available
        if (status.progress) {
          const { completed_keys, total_keys } = status.progress;
          const percentage = total_keys > 0 ? Math.round((completed_keys / total_keys) * 100) : 0;
          progressMsg += ` (${completed_keys}/${total_keys} keys, ${percentage}%)`;
        }

        progressMsg += `, checking again in ${waitSeconds}s...`;
        console.log(chalk.blue(progressMsg));
      }
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      retries = Math.min(retries + 1, 5);
      return { jobId, status: 'pending' };
    }

    return { jobId, status: 'completed', data: status };
  } while (status.status === 'pending' || status.status === 'processing');
}

/**
 * Applies completed translations to the target files
 *
 * @param jobStatus - The job status with translation data
 * @param jobSourceMapping - Mapping of job IDs to source information
 * @param missingByLocale - Missing translations by locale and file
 * @param translationUtils - Translation utilities
 * @param verbose - Whether to show verbose output
 * @param console - Console for logging
 * @param processedEntries - Set of already processed entries
 * @param uniqueKeysTranslated - Set of unique keys that were translated
 * @param stats - Statistics object to update
 * @returns Whether translations were applied
 */
async function applyTranslations(
  jobStatus: JobStatus,
  jobSourceMapping: JobSourceMapping,
  missingByLocale: MissingByLocale,
  translationUtils: TranslationDependencies['translationUtils'],
  verbose: boolean,
  console: TranslationDependencies['console'],
  processedEntries: Set<string>,
  uniqueKeysTranslated: Set<string>,
  stats: TranslationStats,
  config: ProjectConfig
): Promise<boolean> {
  const { jobId, data } = jobStatus;

  if (!data?.translations?.data || !data.language?.code) {
    if (data?.status === 'completed' && data?.language?.code) {
      const languageCode = data.language.code;

      stats.failedLanguages.add(languageCode);
      console.error(chalk.red(`  ❌ Job ${jobId} (${languageCode}) completed with no translations`));
      if (data.error_details) {
        console.error(chalk.gray(`     Error: ${data.error_details}`));
      }
    }

    return false;
  }

  if (data.results_url && !stats.resultsBaseUrl) {
    stats.resultsBaseUrl = data.results_url.split('?')[0];
  }

  const languageCode = data.language.code;
  const sourceInfo = jobSourceMapping[jobId];

  if (!sourceInfo || sourceInfo.locale !== languageCode) {
    return false;
  }

  const localeSourceKey = `${languageCode}:${sourceInfo.sourceFilePath}`;
  const entry = missingByLocale[localeSourceKey];

  if (!entry || processedEntries.has(localeSourceKey)) {
    return false;
  }

  const targetPath = entry.targetPath;
  if (verbose) {
    console.log(chalk.blue(`  Updating translations for ${languageCode} in ${targetPath}`));
  }

  const result = await translationUtils.updateTranslationFile(
    targetPath,
    data.translations.data,
    languageCode,
    entry.path,
    undefined,
    config
  );

  result.updatedKeys.forEach(key => uniqueKeysTranslated.add(key));

  if (verbose && result.updatedKeys.length > 0) {
    result.updatedKeys.forEach(key => {
      const translation = data.translations.data[key];
      if (translation) {
        const truncatedTranslation = typeof translation === 'string' && translation.length > 50
          ? `${translation.substring(0, 47)}…`
          : translation;
        console.log(chalk.gray(`    ${key} → "${truncatedTranslation}"`));
      }
    });
  }

  if (!processedEntries.has(`locale:${languageCode}`)) {
    stats.totalLanguages++;
    stats.languages.add(languageCode);
    processedEntries.add(`locale:${languageCode}`);
  }
  processedEntries.add(localeSourceKey);

  return true;
}

/**
 * Processes a single batch of translations
 *
 * @param batch - The batch to process
 * @param missingByLocale - Missing translations by locale and file
 * @param config - Project configuration
 * @param verbose - Whether to show verbose output
 * @param deps - Dependencies (console, translationUtils)
 * @param processedEntries - Set of already processed entries
 * @param uniqueKeysTranslated - Set of unique keys that were translated
 * @param allJobIds - Array of all job IDs
 * @param stats - Statistics object to update
 */
async function processBatch(
  batch: TranslationBatch,
  missingByLocale: MissingByLocale,
  config: ProjectConfig,
  verbose: boolean,
  deps: TranslationDependencies,
  processedEntries: Set<string>,
  uniqueKeysTranslated: Set<string>,
  allJobIds: string[],
  stats: TranslationStats,
  jobGroupId?: string
): Promise<void> {
  const { console, translationUtils } = deps;
  const sourceFilePath = batch.sourceFilePath;
  const jobRequest = createJobRequest(batch, missingByLocale, config, jobGroupId);
  const response = await translationUtils.createTranslationJob(jobRequest);
  const { jobs } = response;
  const batchJobIds = jobs.map(job => job.id);
  allJobIds.push(...batchJobIds);

  // Capture job group short URL if present in the response
  if (response.job_group?.short_url && !stats.jobGroupShortUrl) {
    stats.jobGroupShortUrl = response.job_group.short_url;
  }

  const jobSourceMapping = createJobSourceMapping(jobs, sourceFilePath);
  const jobTries: Record<string, number> = {};

  const pendingJobs = new Set(batchJobIds);
  while (pendingJobs.size > 0) {
    const jobPromises = Array.from(pendingJobs).map(async jobId => {
      jobTries[jobId] = jobTries[jobId] || 0;
      jobTries[jobId]++;

      if (jobTries[jobId] > MAX_JOB_STATUS_CHECK_ATTEMPTS) {
        // Get final job status to show progress information
        let progressInfo = '';
        try {
          const finalStatus = await translationUtils.checkJobStatus(jobId, false);
          if (finalStatus.progress) {
            const { completed_keys, total_keys } = finalStatus.progress;
            progressInfo = ` (${completed_keys}/${total_keys} keys completed)`;

            if (completed_keys > 0 && completed_keys < total_keys) {
              console.warn(chalk.yellow(`  ⚠️  Job ${jobId} timed out with partial completion${progressInfo}`));
              console.warn(chalk.gray('     The job may complete in the background or can be retried later.'));
            } else if (completed_keys === 0) {
              console.warn(chalk.yellow(`  ❌ Job ${jobId} failed to start processing${progressInfo}`));
              console.warn(chalk.gray('     This may be due to server issues or invalid translation keys.'));
            } else {
              console.warn(chalk.yellow(`  ⏱️  Job ${jobId} may have completed but status is delayed${progressInfo}`));
            }
          } else {
            console.warn(chalk.yellow(`  ❌ Job ${jobId} exceeded maximum retries (${MAX_JOB_STATUS_CHECK_ATTEMPTS}) and will be skipped.`));
          }
        } catch {
          console.warn(chalk.yellow(`  ❌ Job ${jobId} exceeded maximum retries (${MAX_JOB_STATUS_CHECK_ATTEMPTS}) and will be skipped.`));
        }

        pendingJobs.delete(jobId);
        return { jobId, status: 'failed' };
      }

      const jobStatus = await monitorJobStatus(jobId, verbose, translationUtils, console);


      if (jobStatus.status === 'completed') {
        await applyTranslations(
          jobStatus,
          jobSourceMapping,
          missingByLocale,
          translationUtils,
          verbose,
          console,
          processedEntries,
          uniqueKeysTranslated,
          stats,
          config
        );
      }

      return jobStatus;
    });

    // Wait for all jobs to be processed
    const results = await Promise.all(jobPromises);
    results.forEach(result => {
      if (result.status === 'completed') {
        pendingJobs.delete(result.jobId);
      }
    });

    // If there are still pending jobs, wait before checking again
    if (pendingJobs.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Processes translation batches by creating translation jobs,
 * monitoring their status, and applying translations when complete
 *
 * @param batches - Translation batches to process
 * @param missingByLocale - Missing translations by locale and file
 * @param config - Project configuration
 * @param verbose - Whether to show verbose output
 * @param deps - Dependencies (console, translationUtils)
 * @returns Result containing statistics about the translation process
 */
export async function processTranslationBatches(
  batches: TranslationBatch[],
  missingByLocale: MissingByLocale,
  config: ProjectConfig,
  verbose: boolean,
  deps: TranslationDependencies,
  jobGroupId?: string
): Promise<TranslationResult> {
  const stats: TranslationStats = {
    totalLanguages: 0,
    languages: new Set<string>(),
    resultsBaseUrl: null,
    jobGroupShortUrl: null,
    failedLanguages: new Set<string>()
  };
  const processedEntries = new Set<string>();
  const allJobIds: string[] = [];
  const uniqueKeysTranslated = new Set<string>();

  const spinner = !verbose ? new Spinner('Processing translations...') : null;
  spinner?.start();

  try {
    for (const batch of batches) {
      await processBatch(
        batch,
        missingByLocale,
        config,
        verbose,
        deps,
        processedEntries,
        uniqueKeysTranslated,
        allJobIds,
        stats,
        jobGroupId
      );
    }
  } finally {
    spinner?.stop();
  }

  return {
    totalLanguages: stats.totalLanguages,
    languages: Array.from(stats.languages),
    allJobIds,
    resultsBaseUrl: stats.resultsBaseUrl,
    jobGroupShortUrl: stats.jobGroupShortUrl,
    uniqueKeysTranslated,
    failedLanguages: Array.from(stats.failedLanguages)
  };
}
