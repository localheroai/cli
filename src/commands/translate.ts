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
import { getCurrentBranch, getHeadSha } from '../utils/git.js';
import {
  findMissingTranslations,
  batchKeysWithMissing,
  findMissingTranslationsByLocale,
  BatchResult,
  MissingLocaleEntry
} from '../utils/translation-utils.js';
import { autoCommitChanges, buildMakemessagesCommand, type CommitResult } from '../utils/github.js';
import { detectTargetChanges, MAX_TOTAL_CHANGES, type TargetChangeFile } from '../utils/target-changes.js';
import { createPullRequestImport, type PullRequestImportResponse } from '../api/pull-request-imports.js';
import { summarizeImport, type ImportSummary } from '../utils/import-summary.js';
import { processTranslationBatches } from '../utils/translation-processor.js';
import { createIgnoreMatcher, summarizeRemoved } from '../utils/ignore-keys.js';
import { logIgnoreSummary } from '../utils/ignore-keys-logging.js';
import { collectAlignmentCandidates, type AlignmentCandidate } from '../utils/alignment-candidates.js';
import {
  runSourceAlignment,
  reportSourceAlignment,
  summarizeAlignedCells,
  type SourceAlignmentResult
} from '../utils/source-alignment.js';
import { sendAlignedImport } from '../utils/aligned-import.js';
import { keepAlignedCellsOnDisk } from '../utils/aligned-values-on-disk.js';
import type {
  TranslationResult
} from '../utils/translation-processor.js';
import type {
  CommitSummary,
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
    autoCommitChanges: (paths: string, translationSummary?: CommitSummary) => Promise<CommitResult>;
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

const PROJECT_NOT_FOUND_CODE = 'project_not_found';

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isProjectNotFound(error: unknown): boolean {
  return error instanceof ApiResponseError && error.code === PROJECT_NOT_FOUND_CODE;
}

// Names the actual failure (bad key / rate limit / network / server error)
// instead of a generic "could not fetch".
function pluralCategoriesFailureReason(error: unknown): string {
  if (error instanceof ApiResponseError) {
    if (error.code === 'rate_limit_exceeded') {
      return 'the API rate limit was exceeded — try again later';
    }
    const message = error.cliErrorMessage?.trim() || error.message.trim();
    return message || 'an unknown error';
  }
  if (error instanceof Error) {
    return error.message.trim() || 'an unknown error';
  }
  return 'an unknown error';
}

async function fetchLocalePluralCategories(
  projectId: string,
  outputLocales: string[],
  settingsUtils: { fetchSettings: (projectId: string) => Promise<any> },
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
  } catch (error) {
    if (isProjectNotFound(error)) throw error;
    // Without categories, missing-detection falls back to exact key matching, which
    // re-flags flat-target plurals as missing on every run and re-charges credits
    // (#432). Always warn, not just under --verbose.
    const reason = pluralCategoriesFailureReason(error);
    logger.log(chalk.yellow(`\n⚠ Could not fetch locale plural categories (${reason}). Falling back to exact key matching, which can re-translate plural keys that are already translated and use credits. Re-run once resolved if you see unexpected plural updates.\n`));
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
  // A missing project is fatal: nothing later in the run can succeed (#704).
  try {
    config.localePluralCategories = await fetchLocalePluralCategories(
      config.projectId,
      config.outputLocales,
      settingsUtils,
      console
    );
  } catch (error) {
    if (!isProjectNotFound(error)) throw error;
    console.error(chalk.red(`\n✖ Project "${config.projectId}" was not found. Check that projectId in localhero.json is correct and that your API key belongs to the organization that owns the project.\n`));
    process.exit(1);
    return;
  }

  if (verbose) {
    console.log(chalk.blue('\nℹ Using configuration:'));
    console.log(chalk.gray(`  Project ID: ${config.projectId}`));
    console.log(chalk.gray(`  Source locale: ${config.sourceLocale}`));
    console.log(chalk.gray(`  Output locales: ${config.outputLocales.join(', ')}`));
    console.log(chalk.gray(`  Translation files: ${config.translationFiles.paths.join(', ')}`));
  }

  const result = await fileUtils.findTranslationFiles(config, { verbose, returnFullResult: true });
  const { sourceFiles, targetFilesByLocale, allFiles, parseFailures = [] } = result as TranslationFilesResult;

  if (parseFailures.length > 0) {
    console.error(chalk.red(`\n✖ ${parseFailures.length} translation file(s) failed to parse and were skipped:`));
    for (const failure of parseFailures) {
      console.error(chalk.red(`  - ${failure.path}: ${failure.error}`));
    }
    console.error(chalk.red('Every key in a skipped file is missing from this run. Fix the file and re-run.\n'));
    process.exitCode = 1;
  }

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
    if (config.translationFiles?.workflow === 'django') {
      console.error(chalk.yellow('Django writes the source strings to a .pot and deletes it. Keep it and re-run:'));
      console.error(chalk.yellow(`  ${buildMakemessagesCommand(config.outputLocales)}\n`));
    } else {
      console.error(chalk.yellow('This could be due to one of the following issues:'));
      console.error(chalk.yellow(`  1. No translation files with the source locale "${config.sourceLocale}" exist in the configured paths`));
      console.error(chalk.yellow('  2. The locale identifiers in your filenames don\'t match the expected pattern'));
      console.error(chalk.yellow('  3. There was an error parsing one or more files (check for syntax errors in YAML or JSON)\n'));
    }
    console.error(chalk.yellow('Try running with the --verbose flag for more detailed information.\n'));
    process.exit(1);
    return;
  }

  if (verbose) {
    console.log(chalk.blue(`ℹ Found ${sourceFiles.length} source files for locale ${config.sourceLocale}`));
  }

  const projectId = config.projectId;
  const sourceLocale = config.sourceLocale;
  const translationPaths = config.translationFiles.paths.join(' ');
  const jobGroupId = nanoid();
  let alignment: SourceAlignmentResult | null = null;

  async function sendPullRequestImport(targetChanges: TargetChangeFile[]): Promise<void> {
    if (targetChanges.length === 0) return;

    const branch = await getCurrentBranch();
    if (!branch) return;

    let importResult: PullRequestImportResponse;
    try {
      importResult = await createPullRequestImport({
        projectId,
        branch,
        jobGroupId,
        files: targetChanges
      });
    } catch (err) {
      const changeCount = targetChanges.reduce((sum, file) => sum + file.changes.length, 0);
      console.log(chalk.yellow(`⚠ Could not send ${pluralize(changeCount, 'changed value')} for review: ${(err as Error).message}`));
      return;
    }

    reportImport(summarizeImport(targetChanges, sourceLocale, importResult), importResult);
  }

  function reportImport(summary: ImportSummary, importResult: PullRequestImportResponse): void {
    if (summary.importedCount > 0) {
      console.log(`» Sent ${pluralize(summary.importedCount, 'translation value')} from this PR for review`);
    }
    if (summary.unchangedCount > 0) {
      const verb = summary.unchangedCount === 1 ? 'matches' : 'match';
      console.log(chalk.dim(`» ${pluralize(summary.unchangedCount, 'translation value')} already ${verb}`));
    }
    for (const skipped of importResult.skipped) {
      console.log(chalk.yellow(`  Skipped ${skipped.path}: ${skipped.key} (${skipped.reason})`));
    }
    if (summary.sourceTextsImported > 0 && !alignment?.enabled) {
      console.log(chalk.blue(`ℹ ${pluralize(summary.sourceTextsImported, 'source text')} changed. Existing translations were kept; review or align them from the Localhero comment on the PR.`));
    }
  }

  async function sendFinalize(
    manifest: Record<string, any>,
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

  async function alignRewordedSourceTexts(
    candidates: AlignmentCandidate[],
    projectConfig: ProjectConfig
  ): Promise<SourceAlignmentResult | null> {
    if (candidates.length === 0) return null;

    const branch = await getCurrentBranch();
    if (!branch) return null;

    const headSha = await getHeadSha();
    const result = await runSourceAlignment(
      candidates,
      { projectId, branch, jobGroupId, ...(headSha && { headSha }) },
      { console, config: projectConfig, updateTranslationFile: translationUtils.updateTranslationFile }
    );
    reportSourceAlignment(result, console);
    return result;
  }

  function runPostTranslateCommand(command: string | undefined): void {
    if (!command) return;

    try {
      if (verbose) {
        console.log(chalk.blue(`\nℹ Executing postTranslateCommand: ${command}`));
      }
      execUtils.execSync(command, { stdio: verbose ? 'inherit' : 'pipe' });
      if (verbose) {
        console.log(chalk.green('✓ postTranslateCommand completed successfully'));
      }
    } catch (error) {
      const err = error as Error;
      console.warn(chalk.yellow(`\nℹ postTranslateCommand failed: ${err.message}`));
    }
  }

  // Aligned values are staged on the PR only once they are in the branch: after a
  // commit that landed, or right after writing when the pipeline commits itself.
  async function commitChanges(summary: CommitSummary): Promise<void> {
    const alignedCells = keepAlignedCellsOnDisk(alignment?.alignedCells ?? [], sourceLocale, console);
    let inBranch = false;

    if (options.skipCommit) {
      inBranch = process.env.GITHUB_ACTIONS === 'true';
    } else {
      try {
        const result = await gitUtils.autoCommitChanges(translationPaths, {
          ...summary,
          ...summarizeAlignedCells(alignedCells),
          viewUrl: summary.viewUrl || alignment?.shortUrl || undefined
        });
        inBranch = result === 'new';
      } catch (error) {
        const err = error as Error;
        console.warn(chalk.yellow(`\nℹ Could not auto-commit changes: ${err.message}`));
      }
    }

    if (!inBranch || alignedCells.length === 0) return;

    const branch = await getCurrentBranch();
    if (!branch) return;
    await sendAlignedImport(alignedCells, { projectId, branch, jobGroupId }, { console });
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
    manifest = getManifestForFinalize(sourceFiles, config, !!verbose, ignoreMatcher);
    removedManifest = getRemovedKeysManifestForFinalize(sourceFiles, config, !!verbose);
    const detectedChanges = detectTargetChanges(sourceFiles, targetFilesByLocale, config, !!verbose, ignoreMatcher);
    if (detectedChanges === null) {
      console.log(chalk.yellow(`Alignment skipped: this PR has more than ${MAX_TOTAL_CHANGES.toLocaleString('en-US')} translation changes`));
    }
    targetChanges = detectedChanges ?? [];
    const alignmentCandidates = collectAlignmentCandidates(targetChanges, sourceFiles, targetFilesByLocale, config, !!verbose);

    const filtered = filterByGitChanges(
      sourceFiles,
      missingByLocale,
      config,
      !!verbose
    );

    if (filtered !== null) {
      alignment = await alignRewordedSourceTexts(alignmentCandidates, config);

      if (Object.keys(filtered).length === 0) {
        if (manifest !== null) {
          await sendFinalize(manifest, removedManifest);
        }
        await sendPullRequestImport(targetChanges);
        if (alignment?.alignedCells.length) {
          runPostTranslateCommand(config.postTranslateCommand);
          await commitChanges({ keysTranslated: 0, languages: [] });
        }
        console.log(chalk.green('✓ No changed keys need translation'));
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
    const translationResult: TranslationResult = await processTranslationBatches(
      batches,
      missingByLocale as any,
      config,
      !!verbose,
      { console, translationUtils },
      jobGroupId
    );

    if (manifest !== null) {
      await sendFinalize(manifest, removedManifest);
    }

    await sendPullRequestImport(targetChanges);

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
    } else if (parseFailures.length > 0) {
      if (translationResult.uniqueKeysTranslated.size > 0) {
        console.log(`» Updated ${translationResult.uniqueKeysTranslated.size} keys in ${translationResult.totalLanguages} languages`);
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
    }

    if (translationResult.uniqueKeysTranslated.size > 0 || alignment?.alignedCells.length) {
      runPostTranslateCommand(config.postTranslateCommand);
      await commitChanges({
        keysTranslated: translationResult.uniqueKeysTranslated.size,
        languages: translationResult.languages,
        viewUrl: translationResult.jobGroupShortUrl || translationResult.resultsBaseUrl || undefined
      });
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
