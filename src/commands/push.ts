import chalk from 'chalk';
import { importService as defaultImportService } from '../utils/import-service.js';
import { createPromptService, ConfirmOptions } from '../utils/prompt-service.js';
import inquirer from 'inquirer';

const defaultPromptService = createPromptService({
  inquirer: {
    password: async (options) => inquirer.prompt([{ type: 'password', name: 'value', ...options }]).then(r => r.value),
    select: async (options) => inquirer.prompt([{ type: 'list', name: 'value', ...options }]).then(r => r.value),
    input: async (options) => inquirer.prompt([{ type: 'input', name: 'value', ...options }]).then(r => r.value),
    confirm: async (options) => inquirer.prompt([{ type: 'confirm', name: 'value', ...options }]).then(r => r.value)
  }
});

interface PushDependencies {
  importService: {
    pushTranslations: (
      config: any,
      basePath?: string,
      options?: { force?: boolean; verbose?: boolean }
    ) => Promise<{
      status: string;
      error?: string;
      statistics?: {
        created_translations: number;
        updated_translations: number;
      };
      files?: {
        source: any[];
        target: any[];
      };
    }>;
  };
  prompt: {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
  };
  console?: {
    log: (message: string) => void;
  };
}

interface PushOptions {
  verbose?: boolean;
  yes?: boolean;
  force?: boolean;
}

export async function push(
  config: any,
  options: PushOptions = {},
  deps: PushDependencies = {
    importService: defaultImportService,
    prompt: defaultPromptService,
    console: console
  }
): Promise<void> {
  const { verbose = false, yes = false, force = false } = options;
  const { importService, prompt, console: consoleLog = console } = deps;

  if (!yes) {
    const confirmed = await prompt.confirm({
      message: 'This will push your local translations to LocalHero.ai.\nYour changes will be versioned in the API for easy tracking.\nContinue?',
      default: true
    });

    if (!confirmed) {
      consoleLog.log(chalk.yellow('Push cancelled'));
      return;
    }
  }

  const result = await importService.pushTranslations(config, process.cwd(), { force, verbose });

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
    if (result.files?.target.length) {
      consoleLog.log(chalk.green(`✓ Found ${result.files.target.length} translation files`));
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
    consoleLog.log(chalk.green('✓ No translations changes detected'));
  }
}