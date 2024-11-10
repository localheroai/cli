#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { login } from './commands/login.js';
import { init } from './commands/init.js';
import { defaultDependencies } from './utils/defaults.js';
import { translate } from './commands/translate.js';

const program = new Command();

function displayBanner() {
    console.log(chalk.blue(`
  ===============================================
    
                   LocalHero.ai CLI 
                   
  ===============================================
    `));
}

function getVersion() {
    const packageJson = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url))
    );
    return packageJson.version;
}

function handleApiError(error) {
    console.error(chalk.red(`❌ ${error.message}`));
    process.exit(1);
}

function wrapCommandAction(action) {
    return function (...args) {
        return Promise.resolve(action(...args)).catch(handleApiError);
    };
}

program
    .name('localhero')
    .description('CLI tool for automatic I18n translations with LocalHero.ai')
    .version(getVersion())
    .addHelpText('beforeAll', displayBanner)
    .action(() => {
        console.log(`Version: ${getVersion()}`);
        console.log('\nLocalHero.ai is a powerful i18n translation service');
        console.log('that helps you manage your application translations.');
        console.log('\n🔗 Visit https://localhero.ai for more information');
        console.log('💡 Use --help to see available commands');
    });

program
    .command('login')
    .description('Authenticate with LocalHero.ai using an API key')
    .action(wrapCommandAction(() => login(defaultDependencies)));

program
    .command('init')
    .description('Initialize a new LocalHero.ai project')
    .action(wrapCommandAction(() => init(defaultDependencies)));

program
    .command('translate')
    .description('Translate missing keys in your i18n files')
    .option('-v, --verbose', 'Show detailed progress information')
    .action(wrapCommandAction((options) => translate(options)));

program.parse();
