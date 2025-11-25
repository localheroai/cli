import chalk from 'chalk';
import path from 'path';
import { translate, type TranslationOptions } from './translate.js';
import { configService, type ConfigService } from '../utils/config.js';
import { checkAuth } from '../utils/auth.js';
import { githubService } from '../utils/github.js';
import { getSyncTranslations, type SyncFile } from '../api/sync.js';
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
 * Detects if running in a PR context (feature branch)
 * @param env Environment variables
 * @returns true if in PR context (should use --changed-only), false otherwise
 */
function detectPRContext(env: NodeJS.ProcessEnv): boolean {
  const baseRef = env.GITHUB_BASE_REF;

  if (!baseRef) {
    return false;
  }

  if (baseRef === 'main' || baseRef === 'master') {
    return false;
  }

  return true;
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
  const shouldUseChangedOnly = detectPRContext(env);

  if (verbose) {
    const baseRef = env.GITHUB_BASE_REF || 'unknown';
    if (shouldUseChangedOnly) {
      console.log(chalk.blue(`ℹ Auto-detected PR context (base: ${baseRef}) - using --changed-only`));
    } else {
      console.log(chalk.blue(`ℹ Auto-detected main branch context (base: ${baseRef}) - using full translation`));
    }
  }

  const translateOptions: TranslationOptions = {
    ...options,
    changedOnly: shouldUseChangedOnly,
  };

  await translateCommand(translateOptions);
}

/**
 * Run sync mode - fetch done translations from Sync API and update files
 */
async function runSyncMode(
  syncId: string,
  deps: CiDependencies,
  options?: { verbose?: boolean }
): Promise<void> {
  const { console, configUtils, githubUtils } = deps;
  const verbose = options?.verbose || false;

  console.log(chalk.blue('🔄 Syncing translations from LocalHero...\n'));

  const allFiles: SyncFile[] = [];
  let currentPage = 1;
  let totalPages = 1;

  try {
    while (currentPage <= totalPages) {
      const response = await getSyncTranslations(syncId, { page: currentPage });

      if (!response || !response.sync || !response.pagination) {
        throw new Error(`Invalid response from Sync API for page ${currentPage}`);
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

  // Remove sync-trigger-id by re-saving config (saveProjectConfig strips it automatically)
  await configUtils.saveProjectConfig(config);

  console.log(chalk.green(`\n✓ Synced ${translationsUpdated} translations across ${filesUpdated} files`));

  if (githubUtils.isGitHubAction()) {
    githubUtils.autoCommitSyncChanges(modifiedFiles);
  }
}

/**
 * CI command - runs translations optimized for CI/CD environments
 * Auto-detects PR vs main branch context and adjusts behavior accordingly
 * Also detects and handles sync mode when sync-trigger-id is present
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

  // Detect mode based on sync-trigger-id
  const syncTriggerId = config['sync-trigger-id'];

  if (syncTriggerId) {
    if (options.verbose) {
      console.log(chalk.blue('📥 Sync mode detected'));
    }
    try {
      await runSyncMode(syncTriggerId, deps, { verbose: options.verbose });
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
