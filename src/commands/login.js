import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createPromptService } from '../services/prompt-service.js';
import { updateGitignore } from '../utils/git.js';
import { defaultDependencies } from '../utils/defaults.js';
import { verifyApiKey as defaultVerifyApiKey } from '../api/auth.js';
import { saveConfig as defaultSaveConfig } from '../utils/config.js';
import { defaultConfigService } from '../services/config-service.js';

const API_KEY_PATTERN = /^tk_[a-zA-Z0-9]{48}$/;

export async function login(deps = defaultDependencies) {
    const {
        console = global.console,
        basePath = process.cwd(),
        promptService = createPromptService({ inquirer: await import('@inquirer/prompts') }),
        verifyApiKey = defaultVerifyApiKey,
        saveConfig = defaultSaveConfig,
        gitUtils = { updateGitignore },
        configService = defaultConfigService
    } = deps;

    const apiKey = process.env.LOCALHERO_API_KEY || (
        console.log(chalk.blue('\nℹ️  Please enter your API key from https://localhero.com/api-keys\n')),
        await promptService.getApiKey()
    );

    if (!API_KEY_PATTERN.test(apiKey)) {
        throw new Error('Invalid API key format');
    }

    const result = await verifyApiKey(apiKey);

    if (result.error) {
        throw new Error(result.error.message);
    }

    const config = {
        api_key: apiKey,
        last_verified: new Date().toISOString()
    };

    await saveConfig(config, basePath);
    const gitignoreUpdated = await gitUtils.updateGitignore(basePath);

    console.log(chalk.green('\n✓ API key verified and saved to .localhero_key'));
    if (gitignoreUpdated) {
        console.log(chalk.green('✓ Added .localhero_key to .gitignore'));
    }

    console.log(chalk.blue(`💼️  Organization: ${result.organization.name}`));
    console.log(chalk.blue(`📚  Projects: ${result.organization.projects.map(p => p.name).join(', ')}`));

    const projectConfig = await configService.getProjectConfig(basePath);

    if (!projectConfig) {
        console.log(chalk.yellow('\n⚠️  Almost there! You need to set up your project configuration.'));
        console.log(chalk.blue('Run this next:'));
        console.log(chalk.white('\n  npx localhero init\n'));
    } else {
        console.log('\nYou\'re ready to start translating!');
        console.log('Try running: npx localhero translate');
    }
} 