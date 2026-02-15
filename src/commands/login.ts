import chalk from 'chalk';
import { createPromptService } from '../utils/prompt-service.js';
import { updateGitignore } from '../utils/git.js';
import { verifyApiKey as defaultVerifyApiKey } from '../api/auth.js';
import { configService } from '../utils/config.js';
import { AuthConfig } from '../types/index.js';
import type { Organization } from '../types/index.js';

const API_KEY_PATTERN = /^tk_[a-zA-Z0-9]{48}$/;

interface LoginDependencies {
  console?: Console;
  basePath?: string;
  promptService?: ReturnType<typeof createPromptService>;
  verifyApiKey?: typeof defaultVerifyApiKey;
  gitUtils?: { updateGitignore: (path: string) => Promise<boolean> };
  configUtils?: typeof configService;
  isCalledFromInit?: boolean;
  apiKey?: string;
}

export async function login(deps: LoginDependencies = {}): Promise<void> {
  const {
    console = global.console,
    basePath = process.cwd(),
    promptService = createPromptService({ inquirer: await import('@inquirer/prompts') }),
    verifyApiKey = defaultVerifyApiKey,
    gitUtils = { updateGitignore },
    configUtils = configService,
    isCalledFromInit = false,
    apiKey: providedApiKey
  } = deps;

  const existingConfig = await configUtils.getAuthConfig(basePath);

  if (existingConfig?.api_key) {
    console.log(chalk.yellow('\n⚠️  Warning: This will replace your existing API key configuration'));
  }

  const apiKey = providedApiKey || process.env.LOCALHERO_API_KEY || (
    console.log('\n→ Get your API key from: https://localhero.ai/api-keys'),
    console.log('→ New to LocalHero? Sign up at: https://localhero.ai/signup'),
    console.log('\nThe API key will be saved to .localhero_key, and automatically added to your .gitignore file.\n'),
    await promptService.getApiKey()
  );

  if (!apiKey) {
    throw new Error('User cancelled');
  }

  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error('Invalid API key format');
  }

  const result = await verifyApiKey(apiKey);

  if (result.error) {
    if (result.error.code === 'invalid_api_key') {
      console.log(chalk.red('\n❌ ' + result.error.message));
      console.log(chalk.blue('\nℹ️  Get a new API key at https://localhero.ai/api-keys'));
      process.exit(1);
    }
    throw new Error(result.error.message);
  }

  const config: AuthConfig = {
    api_key: apiKey,
    last_verified: new Date().toISOString()
  };

  await configUtils.saveAuthConfig(config, basePath);
  const gitignoreUpdated = await gitUtils.updateGitignore(basePath);

  console.log(chalk.green('\n✓ API key verified and saved to .localhero_key'));
  if (gitignoreUpdated) {
    console.log(chalk.green('✓ Added .localhero_key to .gitignore\n'));
  }

  const organization = result.organization as Organization;
  console.log(chalk.blue(`💼️  Organization: ${organization.name}`));
  if (organization.projects.length > 0) {
    console.log(chalk.blue(`📚  Projects: ${organization.projects.map(p => p.name).join(', ')}`));
  }

  const projectConfig = await configUtils.getProjectConfig(basePath);

  if (!projectConfig && !isCalledFromInit) {
    console.log(chalk.yellow('\n⚠️  Almost there! You need to set up your project configuration.'));
    console.log(chalk.blue('Run this next:'));
    console.log(chalk.white('\n  npx @localheroai/cli init\n'));
  } else if (!isCalledFromInit) {
    console.log('\nYou\'re ready to start translating!');
    console.log('\nTry running: ');
    console.log(chalk.white('  npx @localheroai/cli clone - to download existing translations'));
    console.log(chalk.white('  npx @localheroai/cli translate - to start translating'));
  }

  console.log(chalk.dim('\nTip: Using an AI assistant? Install the Localhero.ai skill: npx skill add localheroai/agent-skill'));
}