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
import { ci, CiOptions } from './commands/ci.js';
import { clone } from './commands/clone.js';
import { glossary, GlossaryOptions } from './commands/glossary.js';
import { settings, SettingsOptions } from './commands/settings.js';
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
  details?: string;
}

function handleApiError(error: CliError): never {
  console.error(chalk.red(`❌ ${error.cliErrorMessage || error.message}`));

  if (program.opts().debug) {
    console.error(chalk.dim(error.stack || error));

    if (error.details) {
      console.error('Details:', chalk.dim(JSON.stringify(error.details, null, 2)));
    }

    if (error.cause) {
      console.error('Cause:', chalk.dim(error.cause.stack || error.cause));
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
  .option('--api-key <key>', 'API key for non-interactive authentication')
  .action(wrapCommandAction((options: { apiKey?: string }) => login({ apiKey: options.apiKey })));

program
  .command('init')
  .description('Initialize a new LocalHero.ai project')
  .action(wrapCommandAction(() => init()));

program
  .command('translate')
  .description('Translate missing keys in your i18n files')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('-c, --commit', 'Automatically commit changes (for CI/CD)')
  .option('--changed-only', 'Only translate keys changed in current branch (experimental)')
  .action(wrapCommandAction((options: TranslationOptions) => translate(options)));

program
  .command('ci')
  .description('Run translations in CI/CD (auto-detects PR vs main context)')
  .option('-v, --verbose', 'Show detailed progress information')
  .action(wrapCommandAction((options: CiOptions) => ci(options)));

program
  .command('pull')
  .description('Pull updates from LocalHero.ai to your local files')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('--changed-only', 'Only pull translations for keys changed in current branch')
  .action(wrapCommandAction((options: { verbose?: boolean; changedOnly?: boolean }) => pull(options)));

program
  .command('push')
  .description('Push updates from your local files to LocalHero.ai')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('-f, --force', 'Push all files regardless of git changes')
  .option('--prune', 'Delete keys from API that no longer exist locally')
  .action(wrapCommandAction(async (options: { verbose?: boolean; yes?: boolean; force?: boolean; prune?: boolean }) => {
    const config = await configService.getValidProjectConfig();
    return push(config, options);
  }));

program
  .command('clone')
  .description('Clone all translations from LocalHero.ai to your local files')
  .option('-v, --verbose', 'Show detailed progress information')
  .option('-f, --force', 'Force, override existing files')
  .action(wrapCommandAction((options: { verbose?: boolean; force?: boolean }) => clone(options)));

program
  .command('glossary')
  .description('Show project glossary terms')
  .option('-o, --output <format>', 'Output format (json)')
  .option('-s, --search <query>', 'Search glossary terms')
  .action(wrapCommandAction((options: GlossaryOptions) => glossary(options)));

program
  .command('settings')
  .description('Show project translation settings')
  .option('-o, --output <format>', 'Output format (json)')
  .action(wrapCommandAction((options: SettingsOptions) => settings(options)));

program.parse();
