#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { login } from './commands/login.js';
import { pull } from './commands/pull.js';
import { push } from './commands/push.js';
import { init } from './commands/init.js';
import { translate, TranslationOptions } from './commands/translate.js';
import { configService } from './utils/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
  );
  return packageJson.version;
}

interface CliError extends Error {
  cliErrorMessage?: string;
  cause?: Error;
}

function handleApiError(error: CliError): never {
  console.error(chalk.red(`❌ ${error.cliErrorMessage || error.message}`));

  if (program.opts().debug) {
    console.error(chalk.dim(error.stack || error));

    if (error.cause) {
      console.error(chalk.dim(error.cause.stack || error.cause));
    }
  } else {
    console.error(chalk.dim('\nRun with --debug for more information'));
  }

  process.exit(1);
}

function wrapCommandAction<T extends (...args: any[]) => Promise<any>>(action: T): (...args: Parameters<T>) => Promise<void> {
  return function (...args: Parameters<T>): Promise<void> {
    return Promise.resolve(action(...args)).catch(handleApiError) as Promise<void>;
  };
}

program
  .name('localhero')
  .description('CLI tool for automatic I18n translations with LocalHero.ai, more info at https://localhero.ai.')
  .version(getVersion())
  .option('--debug', 'Show debug information when errors occur')
  .action(() => {
    console.log('LocalHero.ai is an automatic I18n translation service that easily integrates with your dev workflow.');
    console.log(`\nVersion: ${getVersion()}`);
    console.log('\n👏 Set up your project with `npx @localheroai/cli init`');
    console.log('💡 Use --help to see available commands');
    console.log('🔗 Visit https://localhero.ai for more information');
    console.log('\nWe´re LocalHero.ai, a small, bootstrapped company working to make');
    console.log('i18n simpler for developers like you. If you have any questions or');
    console.log('feedback, just reach out to us at hi@localhero.ai. Thanks 🙌');
  });

program
  .command('login')
  .description('Authenticate with LocalHero.ai using an API key')
  .action(wrapCommandAction(() => login()));

program
  .command('init')
  .description('Initialize a new LocalHero.ai project')
  .action(wrapCommandAction(() => init()));

program
  .command('translate')
  .description('Translate missing keys in your i18n files')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('-c, --commit', 'Automatically commit changes (useful for CI/CD)')
  .action(wrapCommandAction((options: TranslationOptions) => translate(options)));

program
  .command('pull')
  .description('Pull updates from LocalHero.ai to your local files')
  .option('-v, --verbose', 'Show detailed progress information')
  .action(wrapCommandAction((options: { verbose?: boolean }) => pull(options)));

program
  .command('push')
  .description('Push updates from your local files to LocalHero.ai')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(wrapCommandAction(async (options: { verbose?: boolean; yes?: boolean }) => {
    const config = await configService.getValidProjectConfig();
    return push(config, options);
  }));

program.parse();