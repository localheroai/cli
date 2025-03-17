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
    directIndicators: ['config/application.rb', 'Gemfile'],
    defaults: {
      translationPath: 'config/locales/',
      filePattern: '**/*.{yml,yaml}'
    },
    commonPaths: [
      'config/locales'
    ]
  },
  nextjs: {
    directIndicators: ['next.config.js', 'next.config.mjs'],
    packageCheck: {
      requires: ['next'],
      oneOf: ['next-i18next', 'next-translate']
    },
    defaults: {
      translationPath: 'public/locales/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'public/locales',
      'src/locales',
      'locales'
    ]
  },
  vueI18n: {
    directIndicators: ['vue.config.js'],
    packageCheck: {
      oneOf: ['vue-i18n', '@nuxtjs/i18n']
    },
    defaults: {
      translationPath: 'src/locales/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'src/locales',
      'src/i18n',
      'locales',
      'i18n'
    ]
  },
  i18next: {
    directIndicators: ['i18next.config.js', 'i18n.js', 'i18n/index.js'],
    packageCheck: {
      requires: ['i18next']
    },
    defaults: {
      translationPath: 'public/locales/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'public/locales',
      'src/locales',
      'locales',
      'src/i18n',
      'i18n'
    ]
  },
  reactIntl: {
    directIndicators: ['.babelrc'],
    packageCheck: {
      requires: ['react-intl']
    },
    defaults: {
      translationPath: 'src/translations/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'src/i18n',
      'src/translations',
      'src/lang',
      'src/locales',
      'translations',
      'locales'
    ]
  },
  gatsbyReact: {
    directIndicators: ['gatsby-config.js'],
    packageCheck: {
      requires: ['gatsby'],
      oneOf: ['gatsby-plugin-intl', 'gatsby-plugin-i18n']
    },
    defaults: {
      translationPath: 'src/data/i18n/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'src/data/i18n',
      'src/i18n',
      'src/locales',
      'locales'
    ]
  },
  react: {
    directIndicators: ['src/App.js', 'src/App.jsx', 'src/index.js', 'src/index.jsx'],
    packageCheck: {
      requires: ['react']
    },
    defaults: {
      translationPath: 'src/locales/',
      filePattern: '**/*.{json,yml}'
    },
    commonPaths: [
      'src/locales',
      'public/locales',
      'src/i18n',
      'src/translations',
      'src/lang',
      'assets/i18n',
      'locales'
    ]
  },
  generic: {
    directIndicators: [],
    defaults: {
      translationPath: 'locales/',
      filePattern: '**/*.{json,yml,yaml}'
    },
    commonPaths: [
      'locales',
      'src/locales',
      'public/locales',
      'src/i18n',
      'src/translations',
      'src/lang',
      'assets/i18n',
      'i18n',
      'translations',
      'lang'
    ]
  }
};

async function directoryExists(path) {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function findFirstExistingPath(paths) {
  for (const path of paths) {
    if (await directoryExists(path)) {
      return path;
    }
  }
  return null;
}

async function getDirectoryContents(dir) {
  try {
    const files = await fs.readdir(dir);
    return {
      files,
      jsonFiles: files.filter(f => f.endsWith('.json')),
      yamlFiles: files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    };
  } catch {
    return null;
  }
}

async function checkPackageJson() {
  try {
    const content = await fs.readFile('package.json', 'utf8');
    const pkg = JSON.parse(content);
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
}

async function detectFramework(config) {
  for (const indicator of config.directIndicators || []) {
    try {
      const stats = await fs.stat(indicator);
      if (stats.isFile()) return true;
    } catch {
      continue;
    }
  }

  if (config.packageCheck) {
    const deps = await checkPackageJson();
    if (deps) {
      const { requires = [], oneOf = [] } = config.packageCheck;

      if (requires.length && !requires.every(pkg => deps[pkg])) {
        return false;
      }

      if (oneOf.length && !oneOf.some(pkg => deps[pkg])) {
        return false;
      }

      return true;
    }
  }

  return false;
}

async function detectProjectType() {
  for (const [type, config] of Object.entries(PROJECT_TYPES)) {
    if (!config.directIndicators?.length && !config.packageCheck) continue;

    const isFramework = await detectFramework(config);
    if (!isFramework) continue;

    if (config.commonPaths) {
      const translationPath = await findFirstExistingPath(config.commonPaths);
      if (translationPath) {
        return {
          type,
          defaults: {
            ...config.defaults,
            translationPath: `${translationPath}/`
          }
        };
      }
    }
    return { type, defaults: config.defaults };
  }

  const translationPath = await findFirstExistingPath(PROJECT_TYPES.generic.commonPaths);
  if (translationPath) {
    const contents = await getDirectoryContents(translationPath);
    if (contents) {
      return {
        type: 'detected',
        defaults: {
          translationPath: `${translationPath}/`,
          filePattern: contents.jsonFiles.length > 0 && contents.yamlFiles.length === 0
            ? '**/*.json'
            : '**/*.{json,yml,yaml}'
        }
      };
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
        message: 'Source language - the language that we will translate from:',
        default: 'en',
        hint: 'Examples: "en" for en.json/en.yml, "en-US" for en-US.json, or directory name like "en" in /locales/en/common.json'
      }),
      outputLocales: (await promptService.input({
        message: 'Target languages (comma-separated):',
        hint: 'Must match your file names or directory names exactly. Examples: en.json → "en", fr-CA.json → "fr-CA", /locales/de/ → "de"'
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

  const commonPaths = projectDefaults.commonPaths || PROJECT_TYPES.generic.commonPaths;
  const existingDirs = [];

  for (const dir of commonPaths) {
    if (await directoryExists(dir)) {
      existingDirs.push(dir);
    }
  }

  let dirHint = `Directory containing your translation files for ${projectDefaults.type || 'your'} project`;
  if (existingDirs.length > 0) {
    dirHint += `. Found existing directories: ${existingDirs.map(d => `"${d}/"`).join(', ')}`;
  } else {
    dirHint += `. Common paths: ${commonPaths.slice(0, 3).map(d => `"${d}/"`).join(', ')}`;
  }

  const translationPath = await promptService.input({
    message: 'Translation files path:',
    default: projectDefaults.defaults.translationPath,
    hint: dirHint
  });

  let filePattern = projectDefaults.defaults.filePattern;
  const contents = await getDirectoryContents(translationPath);

  if (contents) {
    if (contents.jsonFiles.length > 0 && contents.yamlFiles.length === 0) {
      filePattern = '**/*.json';
    } else if (contents.jsonFiles.length === 0 && contents.yamlFiles.length > 0) {
      filePattern = '**/*.{yml,yaml}';
    } else if (contents.jsonFiles.length > 0 && contents.yamlFiles.length > 0) {
      filePattern = '**/*.{json,yml,yaml}';
    }
  }

  const ignorePaths = await promptService.input({
    message: 'Paths to ignore (comma-separated, leave empty for none):',
    hint: 'Example: "locales/ignored,locales/temp"'
  });

  return {
    ...config,
    projectId,
    translationPath,
    filePattern,
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
      verifyApiKey: authUtils.verifyApiKey,
      isCalledFromInit: true
    });
  }

  console.log('\nLet\'s set up configuration for your project.\n');

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
      pattern: answers.filePattern,
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
      console.log('3. Follow the naming convention: [language-code].[extension] or are in language-specific directories');
      console.log(`4. Include source language files (${config.sourceLocale}.[extension])`);
      console.log('\nSupported JSON formats:');
      console.log('- Nested format: { "navbar": { "home": "Home" } }');
      console.log('- Flat format: { "navbar.home": "Home" }');
      console.log('- With language wrapper: { "en": { "navbar": { "home": "Home" } } }');
      console.log('\nSupported directory structures:');
      console.log('- /locales/en.json, /locales/fr.json');
      console.log('- /locales/en/common.json, /locales/fr/common.json');
      console.log('- /locales/common.en.json, /locales/common.fr.json');
    } else if (importResult.status === 'failed') {
      console.log(chalk.red('\n✗ Failed to import translations'));
      if (importResult.error) {
        console.log(chalk.red(`Error: ${importResult.error}`));
      }
      return;
    } else if (importResult.status === 'completed') {
      console.log(chalk.green('\n✓ Successfully imported translations'));
      await configUtils.updateLastSyncedAt();

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

      if (importResult.translations_url) {
        console.log(chalk.blue(`\nView your translations at: ${importResult.translations_url}`));
      }
    }
  }

  console.log('\n🚀 Done! Start translating with: npx @localheroai/cli translate');
}
