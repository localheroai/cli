import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createPromptService } from '../utils/prompt-service.js';
import { createProject, listProjects } from '../api/projects.js';
import { configService } from '../utils/config.js';
import { checkAuth } from '../utils/auth.js';
import { login } from './login.js';
import { importService } from '../utils/import-service.js';
import { createGitHubActionFile } from '../utils/github.js';

const PROJECT_TYPES = {
    rails: {
        indicators: ['config/application.rb', 'Gemfile'],
        defaults: {
            translationPath: 'config/locales/',
            filePattern: '**/*.{yml,yaml}'
        }
    },
    react: {
        indicators: ['package.json', 'src/locales', 'public/locales'],
        defaults: {
            translationPath: 'src/locales/',
            filePattern: '**/*.{json,yml}'
        }
    },
    generic: {
        indicators: [],
        defaults: {
            translationPath: 'locales/',
            filePattern: '**/*.{json,yml,yaml}'
        }
    }
};

async function detectProjectType() {
    for (const [type, config] of Object.entries(PROJECT_TYPES)) {
        try {
            for (const indicator of config.indicators) {
                await fs.access(indicator);
                return { type, defaults: config.defaults };
            }
        } catch {
            continue;
        }
    }
    return {
        type: 'generic',
        defaults: PROJECT_TYPES.generic.defaults
    };
}

async function selectProject(projectService, promptService) {
    const projects = await projectService.listProjects();

    if (!projects || projects.length === 0) {
        return { choice: 'new' };
    }

    const choices = [
        { name: '✨ Create new project', value: 'new' },
        { name: '─────────────', value: 'separator', disabled: true },
        ...projects.map(p => ({
            name: p.name,
            value: p.id
        }))
    ];
    const projectChoice = await promptService.select({
        message: 'Would you like to use an existing project or create a new one?',
        choices
    });

    return {
        choice: projectChoice,
        project: projects.find(p => p.id === projectChoice)
    };
}

async function promptForConfig(projectDefaults, projectService, promptService, console = global.console) {
    const { choice: projectChoice, project: existingProject } = await selectProject(projectService, promptService);
    let projectId = projectChoice;
    let newProject = false;
    let config = await promptService.getProjectSetup();

    if (!existingProject) {
        config = {
            projectName: await promptService.input({
                message: 'Project name:',
                default: path.basename(process.cwd()),
            }),
            sourceLocale: await promptService.input({
                message: 'Source language - the language that we will translate from (e.g., "en" for en.yml, "en-US" for en-US.json):',
                default: 'en',
            }),
            outputLocales: (await promptService.input({
                message: `Target languages (comma-separated):\n${chalk.gray('Must match your file names exactly. Examples: ')}${chalk.gray('en.yml → use "en", fr-CA.json → use "fr-CA"')}`,
            })).split(',').map(lang => lang.trim()).filter(Boolean)
        };

        try {
            newProject = await projectService.createProject({
                name: config.projectName,
                sourceLocale: config.sourceLocale,
                targetLocales: config.outputLocales
            });
            projectId = newProject.id;
        } catch (error) {
            console.log(chalk.red(`\n✗ Failed to create project: ${error.message}`));
            return null;
        }
    } else {
        config = {
            projectName: existingProject.name,
            sourceLocale: existingProject.source_language,
            outputLocales: existingProject.target_languages
        };
    }

    const translationPath = await promptService.input({
        message: 'Translation files path:',
        default: projectDefaults.defaults.translationPath,
    });
    const ignorePaths = await promptService.input({
        message: 'Paths to ignore (comma-separated, leave empty for none):',
    });

    return {
        ...config,
        projectId,
        translationPath,
        ignorePaths: ignorePaths.split(',').map(p => p.trim()).filter(Boolean),
        newProject
    };
}

export async function init(deps = {}) {
    const {
        console = global.console,
        basePath = process.cwd(),
        promptService = createPromptService({ inquirer: await import('@inquirer/prompts') }),
        configUtils = configService,
        authUtils = { checkAuth },
        importUtils = importService,
        projectApi = { createProject, listProjects },
        login: loginFn = login
    } = deps;

    const existingConfig = await configUtils.getProjectConfig(basePath);
    if (existingConfig) {
        console.log(chalk.yellow('Existing configuration found in localhero.json. Skipping initialization.'));
        return;
    }

    const isAuthenticated = await authUtils.checkAuth();
    if (!isAuthenticated) {
        console.log('LocalHero.ai - Automate your i18n translations\n');
        console.log(chalk.yellow('No API key found. Let\'s get you authenticated.'));

        await loginFn({
            console,
            basePath,
            promptService,
            configUtils,
            verifyApiKey: authUtils.verifyApiKey
        });
    }

    console.log(chalk.blue('\nWelcome to LocalHero.ai!'));
    console.log('Let\'s set up configuration for your project.\n');

    const projectDefaults = await detectProjectType();
    const answers = await promptForConfig(projectDefaults, projectApi, promptService, console);

    if (!answers) {
        return;
    }

    const config = {
        schemaVersion: '1.0',
        projectId: answers.projectId,
        sourceLocale: answers.sourceLocale,
        outputLocales: answers.outputLocales,
        translationFiles: {
            paths: [answers.translationPath],
            ignore: answers.ignorePaths
        }
    };

    await configUtils.saveProjectConfig(config, basePath);
    console.log(chalk.green('\n✓ Created localhero.json'));

    if (answers.newProject) {
        console.log(chalk.green(`✓ Project created, view it at: https://localhero.ai/projects/${answers.projectId}`));
    }

    console.log('Configuration:');
    console.log(JSON.stringify(config, null, 2));
    console.log(' ');

    const shouldSetupGitHubAction = await promptService.confirm({
        message: 'Would you like to set up GitHub Actions for automatic translations?',
        default: true
    });

    if (shouldSetupGitHubAction) {
        try {
            const workflowFile = await createGitHubActionFile(basePath, config.translationFiles.paths);
            console.log(chalk.green(`\n✓ Created GitHub Action workflow at ${workflowFile}`));
            console.log('\nNext steps:');
            console.log('1. Add your API key to your repository\'s secrets:');
            console.log('   - Go to Settings > Secrets > Actions > New repository secret');
            console.log('   - Name: LOCALHERO_API_KEY');
            console.log('   - Value: [Your API Key] (find this at https://localhero.ai/api-keys or in your local .localhero_key file)');
            console.log('\n2. Commit and push the workflow file to enable automatic translations\n');
        } catch (error) {
            console.log(chalk.yellow('\nFailed to create GitHub Action workflow:'), error.message);
        }
    }

    const shouldImport = await promptService.confirm({
        message: 'Would you like to import existing translation files? (recommended)',
        default: true
    });

    if (shouldImport) {
        console.log('\nSearching for translation files...');
        console.log(`Looking in: ${config.translationFiles.paths.join(', ')}`);

        const importResult = await importUtils.importTranslations(config, basePath);

        if (importResult.status === 'no_files') {
            console.log(chalk.yellow('\nNo translation files found.'));
            console.log('Make sure your translation files:');
            console.log('1. Are in the specified path(s)');
            console.log('2. Have the correct file extensions (.json, .yml, or .yaml)');
            console.log('3. Follow the naming convention: [language-code].[extension]');
            console.log(`4. Include source language files (${config.sourceLocale}.[extension])`);
        } else if (importResult.status === 'failed') {
            console.log(chalk.red('\n✗ Failed to import translations'));
            if (importResult.error) {
                console.log(chalk.red(`Error: ${importResult.error}`));
            }
            return;
        } else if (importResult.status === 'completed') {
            console.log(chalk.green('\n✓ Successfully imported translations'));

            if (importResult.files) {
                console.log('\nImported files:');
                [...importResult.files.source, ...importResult.files.target]
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .forEach(file => {
                        const isSource = importResult.files.source.includes(file);
                        console.log(`- ${file.path}${isSource ? ' [source]' : ''}`);
                    });
            }

            if (importResult.sourceImport) {
                console.log(`\nImported ${importResult.sourceImport.statistics.total_keys} source language keys`);

                if (importResult.sourceImport.warnings?.length) {
                    console.log(chalk.yellow('\nWarnings:'));
                    importResult.sourceImport.warnings.forEach(warning => {
                        console.log(`- ${warning.message} (${warning.language})`);
                    });
                }
            }

            console.log('\nTarget Languages:');
            importResult.statistics.languages.forEach(lang => {
                console.log(`${lang.code.toUpperCase()}: ${lang.translated}/${importResult.statistics.total_keys} translated`);
            });

            if (importResult.warnings?.length) {
                console.log(chalk.yellow('\nWarnings:'));
                importResult.warnings.forEach(warning => {
                    console.log(`- ${warning.message} (${warning.language})`);
                });
            }
        }
    }

    console.log('\n🚀 Done! Start translating with: npx @localheroai/cli translate');
}
