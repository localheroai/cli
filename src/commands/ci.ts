import chalk from 'chalk';
import { translate, type TranslationOptions } from './translate.js';
import { configService, type ConfigService } from '../utils/config.js';
import { checkAuth } from '../utils/auth.js';
import { githubService } from '../utils/github.js';

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
 * CI command - runs translations optimized for CI/CD environments
 * Auto-detects PR vs main branch context and adjusts behavior accordingly
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

  await runTranslateMode(options, deps);
}
