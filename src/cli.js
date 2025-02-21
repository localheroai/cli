#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { login } from './commands/login.js';
import { init } from './commands/init.js';
import { translate } from './commands/translate.js';
import { sync } from './commands/sync.js';

const program = new Command();

function getVersion() {
    const packageJson = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url))
    );
    return packageJson.version;
}

function handleApiError(error) {
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

function wrapCommandAction(action) {
    return function (...args) {
        return Promise.resolve(action(...args)).catch(handleApiError);
    };
}

program
    .name('localhero')
    .description('CLI tool for automatic I18n translations with LocalHero.ai, more info at https://localhero.ai.')
    .version(getVersion())
    .option('--debug', 'Show debug information when errors occur')
    .action(() => {
        console.log('LocalHero.ai is automatic I18n translations service that easily integrates with your dev workflow.');
        console.log(`\nVersion: ${getVersion()}`);
        console.log('\n🔗 Visit https://localhero.ai for more information');
        console.log('👏 Set up your project with `npx @localheroai/cli init`');
        console.log('💡 Use --help to see available commands');
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
    .action(wrapCommandAction((options) => translate(options)));

program
    .command('sync')
    .description('Sync updates from LocalHero.ai to your local files')
    .option('-v, --verbose', 'Show detailed progress information')
    .action(wrapCommandAction((options) => sync(options)));

program.parse();
