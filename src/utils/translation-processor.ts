import chalk from 'chalk';
import { ProjectConfig } from '../types/index.js';
import type { SkippedLanguage } from '../types/index.js';
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
  skippedLanguages: Set<string>;
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
  skipped_languages?: SkippedLanguage[];
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
  status: 'pending' | 'processing' | 'completed' | 'validating' | 'failed';
  data?: any;
  progressMarker?: string;
}

export interface TranslationBatch {
  sourceFilePath: string;
  sourceFile: {
    path: string;
    format: string;
    content: string;
    multi_language?: boolean;
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
  skippedLanguages: string[];
  uniqueKeysTranslated: Set<string>;
  failedLanguages: string[];
}

// Large runs keep the server busy well past ten minutes, so the CLI waits as
// long as the jobs keep moving and gives up only on a stall or the hard cap.
export const JOB_STALL_MINUTES = 10;
export const JOB_WAIT_MAX_MINUTES = 60;
const JOB_STALL_MS = JOB_STALL_MINUTES * 60 * 1000;
const JOB_WAIT_MAX_MS = JOB_WAIT_MAX_MINUTES * 60 * 1000;
const FAST_POLL_WINDOW_MS = 60 * 1000;
const FAST_POLL_SECONDS = 3;
const SLOW_POLL_SECONDS = 10;

function pollIntervalSeconds(elapsedMs: number): number {
  return elapsedMs < FAST_POLL_WINDOW_MS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
}

function waitEndReason(elapsedMs: number, sinceProgressMs: number): string | null {
  if (elapsedMs > JOB_WAIT_MAX_MS) return `exceeded maximum wait (${JOB_WAIT_MAX_MINUTES} minutes)`;
  if (sinceProgressMs > JOB_STALL_MS) return `made no progress for ${JOB_STALL_MINUTES} minutes`;
  return null;
}

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

export function localeCodesMatch(a: string, b: string): boolean {
  return a.toLowerCase().replace(/_/g, '-') === b.toLowerCase().replace(/_/g, '-');
}

export function isConfiguredTargetLocale(outputLocales: string[], language: string): boolean {
  // An empty outputLocales means "no restriction" (validated configs always have
  // at least one). Match tolerantly so a config locale (pt-BR) still matches a
  // gettext directory name (pt_BR).
  return outputLocales.length === 0 ||
    outputLocales.some(locale => localeCodesMatch(locale, language));
}

export function isWritableLocale(
  config: Pick<ProjectConfig, 'sourceLocale' | 'outputLocales'>,
  language: string
): boolean {
  return localeCodesMatch(config.sourceLocale, language) ||
    isConfiguredTargetLocale(config.outputLocales ?? [], language);
}

export function skippedLocalesLine(locales: string[]): string {
  return chalk.dim(`Skipped files for ${[...new Set(locales)].join(', ')}: not in outputLocales`);
}

export function toConfigLocale(code: string, config: Pick<ProjectConfig, 'sourceLocale' | 'outputLocales'>): string {
  const configLocales = [config.sourceLocale, ...(config.outputLocales ?? [])];
  return configLocales.find(locale => localeCodesMatch(locale, code)) ?? code;
}

function findMissingEntryKey(
  missingByLocale: MissingByLocale,
  languageCode: string,
  sourceFilePath: string
): string | undefined {
  const exactKey = `${languageCode}:${sourceFilePath}`;
  if (missingByLocale[exactKey]) {
    return exactKey;
  }

  return Object.keys(missingByLocale).find(key => {
    const separatorIndex = key.indexOf(':');
    const keyLocale = key.slice(0, separatorIndex);
    const keySourcePath = key.slice(separatorIndex + 1);
    return keySourcePath === sourceFilePath && localeCodesMatch(keyLocale, languageCode);
  });
}

const WAITING_STATUSES = ['pending', 'processing', 'validating'] as const;

function isWaitingStatus(status: string): boolean {
  return (WAITING_STATUSES as readonly string[]).includes(status);
}

/**
 * Checks a job's status once, waiting before the next check while it is still running
 *
 * @param jobId - The ID of the job to monitor
 * @param verbose - Whether to show verbose output
 * @param translationUtils - Translation utilities
 * @param console - Console for logging
 * @param waitSeconds - How long to wait before the next check if the job is still running
 * @returns The job status
 * @throws Error If the job fails
 */
async function monitorJobStatus(
  jobId: string,
  verbose: boolean,
  translationUtils: TranslationDependencies['translationUtils'],
  console: TranslationDependencies['console'],
  waitSeconds: number
): Promise<JobStatus> {
  if (verbose) {
    console.log(chalk.blue(`\nℹ Checking job ${jobId}`));
  }

  const status = await translationUtils.checkJobStatus(jobId, true);

  if (status.status === 'failed') {
    throw new Error(`Translation job failed: ${status.error_details || 'Unknown error'}`);
  }

  if (isWaitingStatus(status.status)) {
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
    return { jobId, status: 'pending', progressMarker: `${status.status}:${status.progress?.completed_keys ?? ''}` };
  }

  return { jobId, status: 'completed', data: status };
}

/**
 * A file larger than the batch size is split into several batches that all share
 * one missingByLocale entry. Each batch must write only its own chunk of keys, so
 * the scope is per batch rather than per run.
 */
interface BatchScope {
  requestedKeys: Set<string> | undefined;
  appliedEntries: Set<string>;
}

/**
 * Reads the keys a batch asked the API to translate.
 *
 * Returns undefined when the batch carries no key envelope, which leaves the
 * caller to fall back to the missingByLocale entry as the only filter.
 */
function readRequestedKeys(batch: TranslationBatch): Set<string> | undefined {
  try {
    const content = JSON.parse(Buffer.from(batch.sourceFile.content, 'base64').toString());
    return content?.keys ? new Set(Object.keys(content.keys)) : undefined;
  } catch {
    return undefined;
  }
}

function createBatchScope(batch: TranslationBatch): BatchScope {
  return { requestedKeys: readRequestedKeys(batch), appliedEntries: new Set<string>() };
}

function isOtherOnlyLocale(localeCategories: string[] | undefined): boolean {
  return localeCategories?.length === 1 && localeCategories[0] === 'other';
}

/**
 * Finds the requested key a returned key answers, or undefined when the CLI
 * never asked for it. For a YAML plural in a locale whose only plural form is
 * `other`, the API answers a requested `x.other` under the flat key `x`.
 */
function findRequestedKey(
  returnedKey: string,
  entryKeys: MissingTranslationEntry['keys'],
  requestedKeys: Set<string> | undefined,
  otherOnlyLocale: boolean
): string | undefined {
  const isRequested = (key: string): boolean =>
    Object.hasOwn(entryKeys, key) && (!requestedKeys || requestedKeys.has(key));

  if (isRequested(returnedKey)) return returnedKey;
  if (!otherOnlyLocale) return undefined;

  const otherForm = `${returnedKey}.other`;
  const isYamlPlural = entryKeys[otherForm]?.metadata?.plural_format === 'yaml';
  return isYamlPlural && isRequested(otherForm) ? otherForm : undefined;
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
 * @param batchScope - Keys this batch asked for and the entries it has already written
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
  batchScope: BatchScope,
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

  // Skip-auto-translation jobs are authoritative on the job, not its content:
  // the API may echo the locale's existing translations as content, so we must
  // not infer "translated" from a populated payload. Nothing to write, and the
  // locale counts as skipped rather than translated.
  if (data.auto_translate_disabled) {
    stats.skippedLanguages.add(languageCode);
    return false;
  }

  // Fallback for older backends without the explicit flag: a skipped job
  // completes with all-nil content. Nothing to write either way.
  const hasContent = Object.values(data.translations.data).some(
    (value) => value !== null && value !== undefined
  );
  if (!hasContent) {
    return false;
  }

  const localeSourceKey = findMissingEntryKey(missingByLocale, languageCode, sourceInfo.sourceFilePath);

  if (!localeSourceKey || batchScope.appliedEntries.has(localeSourceKey)) {
    return false;
  }

  const entry = missingByLocale[localeSourceKey];
  const targetPath = entry.targetPath;
  const fileLocale = localeSourceKey.slice(0, localeSourceKey.indexOf(':')) || languageCode;
  const { requestedKeys } = batchScope;
  const otherOnlyLocale = isOtherOnlyLocale(config.localePluralCategories?.[fileLocale]);
  const returnedTranslations = Object.entries(data.translations.data);
  const requestedTranslations = returnedTranslations.flatMap(([key, value]) => {
    const requestedKey = findRequestedKey(key, entry.keys, requestedKeys, otherOnlyLocale);
    return requestedKey !== undefined ? [{ key, value, metadata: entry.keys[requestedKey]?.metadata }] : [];
  });
  const unrequestedCount = returnedTranslations.length - requestedTranslations.length;

  if (verbose && unrequestedCount > 0) {
    console.log(chalk.gray(`    Ignored ${unrequestedCount} key(s) not requested for ${languageCode}; local values kept`));
  }

  if (requestedTranslations.length === 0) {
    return false;
  }

  if (verbose) {
    console.log(chalk.blue(`  Updating translations for ${languageCode} in ${targetPath}`));
  }

  const isPoFile = /\.(po|pot)$/i.test(targetPath);
  const translationsToWrite = isPoFile
    ? requestedTranslations.map(({ key, value, metadata }) => ({ key, value, ...(metadata && { metadata }) }))
    : Object.fromEntries(requestedTranslations.map(({ key, value }) => [key, value]));

  const result = await translationUtils.updateTranslationFile(
    targetPath,
    translationsToWrite,
    fileLocale,
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

  if (!stats.languages.has(languageCode)) {
    stats.languages.add(languageCode);
    stats.totalLanguages++;
  }
  batchScope.appliedEntries.add(localeSourceKey);

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
  uniqueKeysTranslated: Set<string>,
  allJobIds: string[],
  stats: TranslationStats,
  jobGroupId?: string
): Promise<void> {
  const { console, translationUtils } = deps;
  const sourceFilePath = batch.sourceFilePath;
  const batchScope = createBatchScope(batch);
  const jobRequest = createJobRequest(batch, missingByLocale, config, jobGroupId);
  const response = await translationUtils.createTranslationJob(jobRequest);
  const { jobs } = response;
  const batchJobIds = jobs.map(job => job.id);
  allJobIds.push(...batchJobIds);

  // Capture job group short URL if present in the response
  if (response.job_group?.short_url && !stats.jobGroupShortUrl) {
    stats.jobGroupShortUrl = response.job_group.short_url;
  }

  for (const skipped of response.skipped_languages ?? []) {
    stats.skippedLanguages.add(skipped.code);
  }

  const jobSourceMapping = createJobSourceMapping(jobs, sourceFilePath);
  const monitoringStartedAt = Date.now();
  let lastProgressAt = monitoringStartedAt;
  const lastProgressMarkers = new Map<string, string>();

  const pendingJobs = new Set(batchJobIds);
  while (pendingJobs.size > 0) {
    const now = Date.now();
    const elapsedMs = now - monitoringStartedAt;
    const endReason = waitEndReason(elapsedMs, now - lastProgressAt);
    const jobPromises = Array.from(pendingJobs).map(async (jobId): Promise<JobStatus> => {
      if (endReason) {
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
            console.warn(chalk.yellow(`  ❌ Job ${jobId} ${endReason} and will be skipped.`));
          }
        } catch {
          console.warn(chalk.yellow(`  ❌ Job ${jobId} ${endReason} and will be skipped.`));
        }

        // However it ran out of time, the job has not delivered its
        // translations. Record it, or the summary reports success for a run
        // that wrote nothing.
        const exhaustedLocale = jobSourceMapping[jobId]?.locale;
        if (exhaustedLocale) {
          stats.failedLanguages.add(exhaustedLocale);
        }

        pendingJobs.delete(jobId);
        return { jobId, status: 'failed' };
      }

      const jobStatus = await monitorJobStatus(jobId, verbose, translationUtils, console, pollIntervalSeconds(elapsedMs));

      if (jobStatus.status === 'completed') {
        await applyTranslations(
          jobStatus,
          jobSourceMapping,
          missingByLocale,
          translationUtils,
          verbose,
          console,
          batchScope,
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
        lastProgressAt = Date.now();
      } else if (result.progressMarker && result.progressMarker !== lastProgressMarkers.get(result.jobId)) {
        lastProgressMarkers.set(result.jobId, result.progressMarker);
        lastProgressAt = Date.now();
      }
    });
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
    failedLanguages: new Set<string>(),
    skippedLanguages: new Set<string>()
  };
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
    skippedLanguages: Array.from(stats.skippedLanguages),
    uniqueKeysTranslated,
    failedLanguages: Array.from(stats.failedLanguages)
  };
}
