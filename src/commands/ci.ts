import chalk from 'chalk';
import path from 'path';
import { translate, type TranslationOptions } from './translate.js';
import { configService, type ConfigService } from '../utils/config.js';
import { checkAuth } from '../utils/auth.js';
import { githubService } from '../utils/github.js';
import { getSyncTranslations, completeSyncUpdate, type SyncFile } from '../api/sync.js';
import { updateTranslationFile } from '../utils/translation-updater/index.js';

// CiOptions is an alias for TranslationOptions
// The ci command accepts all the same options as translate
export type CiOptions = TranslationOptions;

interface CiDependencies {
  console: {
    log: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
  };
  configUtils: ConfigService;
  authUtils: {
    checkAuth: () => Promise<boolean>;
  };
  githubUtils: typeof githubService;
  env: NodeJS.ProcessEnv;
  translateCommand: (options: TranslationOptions) => Promise<void>;
}

const defaultDeps: CiDependencies = {
  console,
  configUtils: configService,
  authUtils: { checkAuth },
  githubUtils: githubService,
  env: process.env,
  translateCommand: translate
};

/**
 * Gets the current branch and determines translation mode
 * @param env Environment variables
 * @returns branch name and whether to use --changed-only mode
 */
function getBranchContext(env: NodeJS.ProcessEnv): { branch: string; useChangedOnly: boolean } {
  // GITHUB_HEAD_REF: source branch of a PR (empty for push/workflow_dispatch)
  // GITHUB_REF_NAME: branch/tag that triggered the workflow
  // See: https://docs.github.com/en/actions/reference/workflows-and-actions/variables
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || 'unknown';
  const useChangedOnly = branch !== 'main' && branch !== 'master';

  return { branch, useChangedOnly };
}

/**
 * Run translation mode with defaults for CI/CD
 */
async function runTranslateMode(
  options: CiOptions,
  deps: CiDependencies
): Promise<void> {
  const { verbose } = options;
  const { console, env, translateCommand } = deps;
  const { branch, useChangedOnly } = getBranchContext(env);

  if (verbose) {
    if (useChangedOnly) {
      console.log(chalk.blue(`ℹ On branch '${branch}' - using --changed-only`));
    } else {
      console.log(chalk.blue(`ℹ On branch '${branch}' - using full translation`));
    }
  }

  const translateOptions: TranslationOptions = {
    ...options,
    changedOnly: useChangedOnly,
  };

  await translateCommand(translateOptions);
}

/**
 * Run sync mode - fetch done translations from Sync API and update files
 */
async function runSyncMode(
  syncId: string,
  deps: CiDependencies,
  options?: { verbose?: boolean; syncUpdateVersion?: number }
): Promise<void> {
  const { console, configUtils, githubUtils } = deps;
  const verbose = options?.verbose || false;

  console.log(chalk.blue('🔄 Syncing translations from LocalHero...\n'));

  const allFiles: SyncFile[] = [];
  let currentPage = 1;
  let totalPages = 1;
  let syncUrl: string | undefined;

  try {
    while (currentPage <= totalPages) {
      const response = await getSyncTranslations(syncId, { page: currentPage });

      if (!response || !response.sync || !response.pagination) {
        throw new Error(`Invalid response from Sync API for page ${currentPage}`);
      }

      if (currentPage === 1) {
        syncUrl = response.sync.sync_url;
      }

      allFiles.push(...response.sync.files);
      totalPages = response.pagination.total_pages;
      currentPage++;

      if (verbose && totalPages > 1) {
        console.log(chalk.gray(`  Fetched page ${currentPage - 1}/${totalPages}`));
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch translations (page ${currentPage}/${totalPages}): ${errorMessage}`);
  }

  if (verbose) {
    console.log(chalk.gray(`  Total files to update: ${allFiles.length}\n`));
  }

  const config = await configUtils.getValidProjectConfig();
  const modifiedFiles: string[] = [];
  let filesUpdated = 0;
  let translationsUpdated = 0;

  const projectRoot = process.cwd();

  for (const file of allFiles) {
    const absolutePath = path.resolve(file.path);
    const relativePath = path.relative(projectRoot, absolutePath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      console.error(chalk.yellow(`  ⚠️  Skipping invalid path: ${file.path}`));
      continue;
    }

    if (verbose) {
      console.log(chalk.gray(`  Updating ${file.path} (${file.language})...`));
    }

    await updateTranslationFile(
      file.path,
      file.translations,
      file.language,
      undefined,
      config.sourceLocale,
      config
    );

    filesUpdated++;
    translationsUpdated += file.translations.length;
    modifiedFiles.push(file.path);
  }

  // Remove syncTriggerId by re-saving config (saveProjectConfig strips it automatically)
  await configUtils.saveProjectConfig(config);

  console.log(chalk.green(`\n✓ Synced ${translationsUpdated} translations across ${filesUpdated} files`));

  if (githubUtils.isGitHubAction()) {
    const languages = [...new Set(allFiles.map(f => f.language))];
    await githubUtils.autoCommitSyncChanges(modifiedFiles, {
      keysTranslated: translationsUpdated,
      languages,
      viewUrl: syncUrl
    });
  }

  if (options?.syncUpdateVersion) {
    try {
      await completeSyncUpdate(syncId, options.syncUpdateVersion);
      if (verbose) {
        console.log(chalk.gray(`  Marked sync update ${options.syncUpdateVersion} as completed`));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`  ⚠️  Could not mark sync update as completed: ${errorMessage}`));
    }
  }
}

/**
 * CI command - runs translations optimized for CI/CD environments
 * Auto-detects PR vs main branch context and adjusts behavior accordingly
 * Also detects and handles sync mode when syncTriggerId is present
 */
export async function ci(
  options: CiOptions = {},
  deps: CiDependencies = defaultDeps
): Promise<void> {
  const { console, configUtils, authUtils, githubUtils } = deps;

  if (!githubUtils.isGitHubAction()) {
    console.error(chalk.yellow('\n⚠ Warning: This command is designed to run in CI/CD environments.'));
    console.error(chalk.yellow('  For local development, use `npx @localheroai/cli translate` instead.\n'));
  }

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.error(chalk.red('\n✖ Your API key is invalid. Please check LOCALHERO_API_KEY secret.\n'));
    process.exit(1);
  }
  const config = await configUtils.getProjectConfig();
  if (!config) {
    console.error(chalk.red('\n✖ No configuration found. localhero.json is missing.\n'));
    process.exit(1);
  }

  const syncTriggerId = config.syncTriggerId;

  if (syncTriggerId) {
    if (options.verbose) {
      console.log(chalk.blue('📥 Sync mode detected'));
    }
    try {
      await runSyncMode(syncTriggerId, deps, { verbose: options.verbose, syncUpdateVersion: config.syncUpdateVersion });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\n✖ Sync failed:', errorMessage));
      console.log(chalk.yellow('\nSync trigger ID preserved for retry.\n'));
      process.exit(1);
    }
  } else {
    if (options.verbose) {
      console.log(chalk.blue('🔄 Translate mode detected\n'));
    }
    await runTranslateMode(options, deps);
  }
}
