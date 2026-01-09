import chalk from 'chalk';
import { importService as defaultImportService } from '../utils/import-service.js';
import { createPromptService, ConfirmOptions, defaultInquirerAdapter } from '../utils/prompt-service.js';
import { bulkDeleteKeys as defaultBulkDeleteKeys } from '../api/keys.js';
import { ProjectConfig, PrunableKey, ImportFile } from '../types/index.js';

const MAX_KEYS_TO_DISPLAY = 10;

const defaultPromptService = createPromptService({
  inquirer: defaultInquirerAdapter
});

interface PushResult {
  status: string;
  error?: string;
  statistics?: {
    created_translations: number;
    updated_translations: number;
  };
  files?: {
    source: ImportFile[];
    target: ImportFile[];
  };
  prunable_keys?: PrunableKey[];
}

interface PushDependencies {
  importService: {
    pushTranslations: (
      config: ProjectConfig,
      basePath?: string,
      options?: { force?: boolean; verbose?: boolean; prune?: boolean }
    ) => Promise<PushResult>;
  };
  prompt: {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
  };
  console?: {
    log: (message: string) => void;
  };
  bulkDeleteKeys?: (params: { projectId: string; keyIds: string[] }) => Promise<{ deleted_count: number }>;
}

interface PushOptions {
  verbose?: boolean;
  yes?: boolean;
  force?: boolean;
  prune?: boolean;
}

export async function push(
  config: ProjectConfig,
  options: PushOptions = {},
  deps: PushDependencies = {
    importService: defaultImportService,
    prompt: defaultPromptService,
    console: console,
    bulkDeleteKeys: defaultBulkDeleteKeys
  }
): Promise<void> {
  const { verbose = false, yes = false, force = false, prune = false } = options;
  const { importService, prompt, console: consoleLog = console, bulkDeleteKeys = defaultBulkDeleteKeys } = deps;

  if (prune && !force && !yes) {
    consoleLog.log(chalk.yellow('\n⚠ You\'re using --prune without --force.'));
    consoleLog.log(chalk.dim('  Only keys in changed files will be checked for pruning.'));
    consoleLog.log(chalk.dim('  Keys in unchanged files will NOT be pruned.\n'));

    const confirmed = await prompt.confirm({
      message: 'Continue with filtered prune?',
      default: false
    });

    if (!confirmed) {
      consoleLog.log(chalk.yellow('Push cancelled'));
      return;
    }
  } else if (!yes) {
    const message = prune
      ? 'This will push your local translations and identify stale keys to prune.\nContinue?'
      : 'This will push your local translations to LocalHero.ai.\nYour changes will be versioned in the API for easy tracking.\nContinue?';

    const confirmed = await prompt.confirm({
      message,
      default: true
    });

    if (!confirmed) {
      consoleLog.log(chalk.yellow('Push cancelled'));
      return;
    }
  }

  const result = await importService.pushTranslations(config, process.cwd(), { force, verbose, prune });

  if (result.status === 'no_files') {
    consoleLog.log(chalk.yellow('No translation files found'));
    return;
  }

  if (result.status === 'no_changes') {
    consoleLog.log(chalk.green('✓ No translation changes detected'));
    consoleLog.log(chalk.dim("Use 'npx localhero push --force' to push all files anyway"));
    return;
  }

  if (result.status === 'failed') {
    throw new Error(result.error || 'Failed to push translations');
  }

  if (verbose) {
    const totalFiles = (result.files?.source.length || 0) + (result.files?.target.length || 0);
    if (totalFiles > 0) {
      consoleLog.log(chalk.green(`✓ Found ${totalFiles} translation files`));
    }
  }

  const { statistics } = result;
  if (statistics && (statistics.updated_translations > 0 || statistics.created_translations > 0)) {
    if (statistics.updated_translations > 0) {
      consoleLog.log(chalk.green(`✓ Updated ${statistics.updated_translations} translations`));
    }
    if (statistics.created_translations > 0) {
      consoleLog.log(chalk.green(`✓ Added ${statistics.created_translations} new translations`));
    }
  } else {
    consoleLog.log(chalk.green('✓ No translation changes detected'));
  }

  if (prune && result.prunable_keys) {
    await handlePruning(config, result.prunable_keys, {
      yes,
      consoleLog,
      prompt,
      bulkDeleteKeys
    });
  }
}

async function handlePruning(
  config: ProjectConfig,
  prunableKeys: PrunableKey[],
  deps: {
    yes: boolean;
    consoleLog: { log: (message: string) => void };
    prompt: { confirm: (options: ConfirmOptions) => Promise<boolean> };
    bulkDeleteKeys: (params: { projectId: string; keyIds: string[] }) => Promise<{ deleted_count: number }>;
  }
): Promise<void> {
  const { yes, consoleLog, prompt, bulkDeleteKeys } = deps;

  if (prunableKeys.length === 0) {
    consoleLog.log(chalk.green('✓ No stale keys to prune'));
    return;
  }

  consoleLog.log(chalk.yellow(`\n⚠ ${prunableKeys.length} key${prunableKeys.length === 1 ? '' : 's'} found for pruning (no longer exist in local files):`));

  const keysToShow = prunableKeys.slice(0, MAX_KEYS_TO_DISPLAY);
  for (const key of keysToShow) {
    const contextInfo = key.context ? ` (context: ${key.context})` : '';
    consoleLog.log(chalk.dim(`  - ${key.name}${contextInfo}`));
  }

  if (prunableKeys.length > MAX_KEYS_TO_DISPLAY) {
    consoleLog.log(chalk.dim(`  ... and ${prunableKeys.length - MAX_KEYS_TO_DISPLAY} more`));
  }

  if (!yes) {
    consoleLog.log('');
    const confirmed = await prompt.confirm({
      message: 'Prune these keys? This cannot be undone.',
      default: false
    });

    if (!confirmed) {
      consoleLog.log(chalk.yellow('Prune cancelled'));
      return;
    }
  }

  const deleteResult = await bulkDeleteKeys({
    projectId: config.projectId,
    keyIds: prunableKeys.map(k => k.id)
  });

  consoleLog.log(chalk.green(`✓ Pruned ${deleteResult.deleted_count} key${deleteResult.deleted_count === 1 ? '' : 's'}`));
}
