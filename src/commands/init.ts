import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createPromptService, ProjectSelectionResult, ProjectSetup, SelectOptions, InputOptions, ConfirmOptions } from '../utils/prompt-service.js';
import { createProject, listProjects, ProjectDetails } from '../api/projects.js';
import { configService } from '../utils/config.js';
import { checkAuth } from '../utils/auth.js';
import { login } from './login.js';
import { importService, ImportResult } from '../utils/import-service.js';
import { createGitHubActionFile, workflowExists } from '../utils/github.js';
import { directoryExists, findFirstExistingPath, getDirectoryContents } from '../utils/files.js';
import { ProjectConfig as BaseProjectConfig } from '../types/index.js';
import { verifyApiKey } from '../api/auth.js';
import { Spinner } from '../utils/spinner.js';

// Additional interfaces for better type safety
interface ImportStatistics {
  total_keys?: number;
  created_keys?: number;
  created_translations: number;
  updated_translations: number;
  languages?: Array<{
    code: string;
    translated?: number;
    missing?: number;
  }>;
}

interface ImportWarning {
  message: string;
}

interface TypedImportResult extends Omit<ImportResult, 'statistics' | 'warnings'> {
  statistics?: ImportStatistics;
  warnings?: Array<ImportWarning | string>;
}

interface IPromptService {
  getApiKey(): Promise<string>;
  getProjectSetup(): Promise<ProjectSetup>;
  select(options: SelectOptions): Promise<string>;
  input(options: InputOptions): Promise<string>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  selectProject(service: { listProjects: () => Promise<Array<{ id: string; name: string }>> }): Promise<ProjectSelectionResult>;
}

interface ValidationResult {
  isValid: boolean;
  missingFields: string[];
}

interface ImportProcessResult {
  success: boolean;
  hasWarnings: boolean;
}

interface WorkflowSetupResult {
  created: boolean;
  error?: string;
}

interface ProjectTypeConfig {
  directIndicators?: string[];
  packageCheck?: {
    requires?: string[];
    oneOf?: string[];
  };
  defaults: {
    translationPath: string;
    filePattern: string;
    commonPaths?: string[];
    ignorePaths?: string[];
    workflow?: string;
  };
  commonPaths?: string[];
}

type ProjectTypes = Record<string, ProjectTypeConfig>;

interface PackageDependencies {
  [key: string]: string;
}

interface ProjectDetectionResult {
  type: string;
  defaults: {
    translationPath: string;
    filePattern: string;
    commonPaths?: string[];
    ignorePaths?: string[];
    workflow?: string;
  };
}

interface InitDependencies {
  console?: Console;
  basePath?: string;
  promptService?: IPromptService;
  configUtils?: typeof configService;
  authUtils?: {
    checkAuth: typeof checkAuth;
    verifyApiKey?: typeof verifyApiKey;
  };
  importUtils?: typeof importService;
  projectApi?: {
    createProject: typeof createProject;
    listProjects: typeof listProjects;
  };
  login?: typeof login;
}

interface InitAnswers {
  projectId: string;
  sourceLocale: string;
  outputLocales: string[];
  translationPath?: string;
  filePattern?: string;
  ignorePaths?: string[];
  newProject?: boolean;
  url?: string | null;
}

const PROJECT_TYPES: ProjectTypes = {
  django: {
    directIndicators: ['manage.py'],
    defaults: {
      translationPath: 'translations/',
      filePattern: '**/*.po',
      ignorePaths: ['**/sources/**'],
      workflow: 'django'
    },
    commonPaths: [
      'translations',
      'locale',
      'locales'
    ]
  },
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
      filePattern: '**/*.{json,yml,yaml,po}'
    },
    commonPaths: [
      'src/locales',
      'public/locales',
      'config/locales',
      'locales',
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

async function checkPackageJson(): Promise<PackageDependencies | null> {
  try {
    const content = await fs.readFile('package.json', 'utf8');
    const pkg = JSON.parse(content);
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
}

async function detectFramework(config: ProjectTypeConfig): Promise<boolean> {
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

async function detectProjectType(): Promise<ProjectDetectionResult> {
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
            translationPath: `${translationPath}/`,
            commonPaths: config.commonPaths
          }
        };
      }
    }
    return {
      type,
      defaults: {
        ...config.defaults,
        commonPaths: config.commonPaths
      }
    };
  }

  const commonPaths = PROJECT_TYPES.generic.commonPaths || [];
  const translationPath = await findFirstExistingPath(commonPaths);
  if (translationPath) {
    const contents = await getDirectoryContents(translationPath);
    if (contents) {
      return {
        type: 'detected',
        defaults: {
          commonPaths: commonPaths,
          translationPath: `${translationPath}/`,
          filePattern: (() => {
            const formats: string[] = [];
            if (contents.jsonFiles.length > 0) formats.push('json');
            if (contents.yamlFiles.length > 0) formats.push('yml', 'yaml');
            if (contents.poFiles.length > 0) formats.push('po');

            return formats.length === 1 && formats[0] !== 'yml'
              ? `**/*.${formats[0]}`
              : `**/*.{${formats.join(',')}}`;
          })()
        }
      };
    }
  }

  return {
    type: 'generic',
    defaults: {
      ...PROJECT_TYPES.generic.defaults,
      commonPaths: commonPaths
    }
  };
}

async function validateExistingConfig(config: BaseProjectConfig): Promise<ValidationResult> {
  const requiredFields = ['projectId', 'sourceLocale', 'outputLocales'];
  const missingFields = requiredFields.filter(field => !config[field]);

  return {
    isValid: missingFields.length === 0,
    missingFields
  };
}

async function handleImportProcess(
  config: BaseProjectConfig,
  basePath: string,
  importUtils: typeof importService,
  console: Console,
  configUtils: typeof configService
): Promise<ImportProcessResult> {
  const spinner = new Spinner('Importing translations...');
  spinner.start();

  try {
    const importResult = await importUtils.importTranslations(config, basePath) as TypedImportResult;
    spinner.stop();

    if (importResult.status === 'no_files') {
      console.log(chalk.yellow('No translation files found.'));
      return { success: true, hasWarnings: true };
    }

    if ((importResult.status === 'completed' || importResult.status === 'success') && importResult.statistics) {
      console.log(chalk.green('\n✓ Successfully imported translations'));

      console.log('\nImport summary:');
      if (importResult.files) {
        const sourceCount = importResult.files.source.length;
        const targetCount = importResult.files.target.length;
        console.log(`- ${sourceCount + targetCount} translation files imported`);
        console.log(`- ${sourceCount} source files (${config.sourceLocale})`);
        console.log(`- ${targetCount} target files (${config.outputLocales.join(', ')})`);
      }

      const stats = importResult.statistics;
      if (stats) {
        console.log(`- Total keys: ${stats.total_keys || 0}`);

        if (Array.isArray(stats.languages)) {
          const validLanguages = stats.languages.filter(lang => lang.code);
          console.log(`- Languages: ${validLanguages.length}`);
          validLanguages.forEach((lang) => {
            console.log(`  - ${lang.code}: ${lang.translated || 0} keys (${lang.missing || 0} missing)`);
          });
        }
      }

      if (importResult.warnings && importResult.warnings.length > 0) {
        console.log(`\n${chalk.yellow('⚠')} Warnings:`);
        importResult.warnings.forEach((warning) => {
          const message = typeof warning === 'string' ? warning : warning.message || 'Unknown warning';
          console.log(`- ${message}`);
        });
      }

      if (importResult.translations_url) {
        console.log(chalk.green(`\nView your translations at: ${importResult.translations_url}`));
      }

      await configUtils.updateLastSyncedAt(basePath);

      return { success: true, hasWarnings: (importResult.warnings?.length || 0) > 0 };
    }

    if (importResult.status === 'failed' || importResult.status === 'error') {
      console.log(chalk.red('✗ Failed to import translations'));
      console.log(chalk.red(`Error: ${importResult.error || 'Import failed'}`));
      return { success: false, hasWarnings: false };
    }

    return { success: true, hasWarnings: false };
  } catch (error) {
    spinner.stop();
    const errorMessage = error instanceof Error ? error.message : 'Import failed';
    console.log(chalk.red('✗ Failed to import translations'));
    console.log(chalk.red(`Error: ${errorMessage}`));
    return { success: false, hasWarnings: false };
  }
}

async function handleGitHubWorkflowSetup(
  basePath: string,
  translationPaths: string[],
  promptService: IPromptService,
  console: Console
): Promise<WorkflowSetupResult> {
  if (workflowExists(basePath)) {
    console.log(chalk.green('✓ GitHub Actions workflow found'));
    console.log(chalk.yellow('\n⚠️  Remember to add your API key to repository secrets:'));
    console.log('   Name: LOCALHERO_API_KEY');
    console.log('   Value: Get from https://localhero.ai/api-keys');
    console.log('   Location: Repository Settings → Secrets and variables → Actions (On GitHub repo page)\n');
    return { created: false };
  }

  const shouldSetupGitHubAction = await promptService.confirm({
    message: 'Would you like to set up GitHub Actions for automatic translations?',
    default: true
  });

  if (!shouldSetupGitHubAction) {
    return { created: false };
  }

  try {
    const workflowFile = await createGitHubActionFile(basePath, translationPaths);
    console.log(chalk.green(`\n✓ Created GitHub Action workflow at ${workflowFile}`));
    console.log('\nNext steps:');
    console.log('1. Add your API key to your repository\'s secrets:');
    console.log('   - Go to Settings > Secrets and variables > Actions > New repository secret');
    console.log('   - Name: LOCALHERO_API_KEY');
    console.log('   - Value: [Your API Key] (find this at https://localhero.ai/api-keys)');
    console.log('2. Commit and push the workflow file to enable automatic translations\n');
    return { created: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.yellow('Failed to create GitHub Action workflow:'), errorMessage);
    return { created: false, error: errorMessage };
  }
}

function displayFinalInstructions(
  workflowCreated: boolean,
  workflowExists: boolean,
  hasErrors: boolean,
  console: Console
): void {
  if (hasErrors) {
    return;
  }

  console.log('\n🎉 Setup complete!');

  if (workflowCreated) {
    console.log('\n📝 Don\'t forget to commit and push the new workflow file.');
  }

  if (workflowExists) {
    console.log('\nTranslations will run automatically on pull requests, or manually with:');
  } else {
    console.log('\nYou can run translations manually with:');
  }
  console.log('  npx @localheroai/cli translate');
}

async function handleExistingConfiguration(
  existingConfig: BaseProjectConfig,
  deps: Required<Pick<InitDependencies, 'console' | 'basePath' | 'promptService' | 'configUtils' | 'authUtils' | 'importUtils' | 'projectApi' | 'login'>>
): Promise<void> {
  const { console, basePath, promptService, authUtils, projectApi, login: loginFn, importUtils, configUtils } = deps;

  let workflowCreated = false;
  console.log(chalk.green('✓ Configuration found! Let\'s verify and set up your API access.\n'));

  const validation = await validateExistingConfig(existingConfig);
  if (!validation.isValid) {
    console.log(chalk.red(`✗ Invalid configuration: missing fields ${validation.missingFields.join(', ')}`));
    console.log(chalk.yellow('Please check your localhero.json file and try again.\n'));
    return;
  }

  console.log(chalk.blue('📋 Project Configuration:'));
  console.log(`   Project ID: ${existingConfig.projectId}`);
  console.log(`   Source: ${existingConfig.sourceLocale}`);
  console.log(`   Targets: ${existingConfig.outputLocales.join(', ')}`);
  console.log(`   Pattern: ${existingConfig.translationFiles?.pattern || 'not specified'}\n`);

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.log('Let\'s connect to your LocalHero account.');

    await loginFn({
      console,
      basePath,
      promptService,
      configUtils: deps.configUtils,
      verifyApiKey: authUtils.verifyApiKey,
      isCalledFromInit: true
    });
  } else {
    console.log(chalk.green('✓ API key found and valid'));

    try {
      const projects = await projectApi.listProjects();
      const projectExists = projects.some(p => p.id === existingConfig.projectId);
      if (!projectExists) {
        console.log(chalk.red(`✗ Project ${existingConfig.projectId} not found in your organization`));
        console.log(chalk.yellow('Please check your localhero.json file or contact support.\n'));
        return;
      }
      console.log(chalk.green('✓ Project access verified'));
    } catch {
      console.log(chalk.yellow('⚠️  Could not verify project access. Continuing anyway...\n'));
    }
  }

  // Check if we've previously imported files
  if (existingConfig.lastSyncedAt) {
    console.log(chalk.green('✓ Translation files previously imported'));
  } else {
    const shouldImport = await promptService.confirm({
      message: 'Would you like to import existing translation files? (recommended)',
      default: true
    });

    if (shouldImport) {
      await handleImportProcess(existingConfig, basePath, importUtils, console, configUtils);
    }
  }

  const workflowResult = await handleGitHubWorkflowSetup(
    basePath,
    existingConfig.translationFiles?.paths || [''],
    promptService,
    console
  );
  workflowCreated = workflowResult.created;

  displayFinalInstructions(workflowCreated, workflowExists(basePath), false, console);
}

async function handleNewProjectSetup(
  deps: Required<Pick<InitDependencies, 'console' | 'basePath' | 'promptService' | 'configUtils' | 'authUtils' | 'importUtils' | 'projectApi' | 'login'>>
): Promise<void> {
  const { console, basePath, promptService, authUtils, projectApi, login: loginFn, importUtils, configUtils } = deps;

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    console.log('LocalHero.ai - Automate your i18n translations\n');
    console.log(chalk.yellow('No API key found. Let\'s get you authenticated.'));

    await loginFn({
      console,
      basePath,
      promptService,
      configUtils,
      verifyApiKey: authUtils.verifyApiKey || verifyApiKey,
      isCalledFromInit: true
    });
  }

  console.log('\nLet\'s set up configuration for your project.\n');

  let workflowCreated = false;
  const projectDefaults = await detectProjectType();
  const answers: InitAnswers | null = await promptForConfig(projectDefaults, projectApi, promptService, console);
  if (!answers) {
    return;
  }

  const config: BaseProjectConfig = {
    schemaVersion: '1.0',
    projectId: answers.projectId,
    sourceLocale: answers.sourceLocale,
    outputLocales: answers.outputLocales,
    translationFiles: {
      paths: answers.translationPath ? [answers.translationPath] : [],
      pattern: answers.filePattern || '**/*.{json,yml,yaml,po}',
      ignore: answers.ignorePaths || [],
      ...(projectDefaults.defaults.workflow && { workflow: projectDefaults.defaults.workflow as 'default' | 'django' })
    },
    lastSyncedAt: null
  };

  await configUtils.saveProjectConfig(config, basePath);
  console.log(chalk.green('\n✓ Created localhero.json'));

  if (answers.newProject) {
    console.log(chalk.green(`✓ Project created, view it at: ${answers.url}\n`));
  }

  const workflowResult = await handleGitHubWorkflowSetup(
    basePath,
    answers.translationPath ? [answers.translationPath] : [''],
    promptService,
    console
  );
  workflowCreated = workflowResult.created;

  const shouldImport = await promptService.confirm({
    message: 'Would you like to import existing translation files? (recommended)',
    default: true
  });

  let hasErrors = false;
  if (shouldImport) {
    console.log('\nSearching for translation files in:');
    console.log(`${config.translationFiles.paths.join(', ')}`);

    const importResult = await handleImportProcess(config, basePath, importUtils, console, configUtils);
    hasErrors = !importResult.success;
  }

  displayFinalInstructions(workflowCreated, workflowExists(basePath), hasErrors, console);
}

async function promptForConfig(
  projectDefaults: ProjectDetectionResult,
  projectService: { createProject: typeof createProject; listProjects: typeof listProjects },
  promptService: IPromptService,
  console: Console = global.console
): Promise<InitAnswers | null> {
  const { choice: projectChoice, project: existingProject } = await promptService.selectProject(projectService);
  if (!projectChoice) {
    throw new Error('Project selection is required');
  }
  let projectId = projectChoice;
  let newProject: ProjectDetails | null = null;
  let projectUrl: string | null = null;
  let config: {
    projectName: string;
    sourceLocale: string;
    outputLocales: string[];
  };

  if (!existingProject) {
    config = {
      projectName: await promptService.input({
        message: 'Project name:',
        default: path.basename(process.cwd()),
      }),
      sourceLocale: await promptService.input({
        message: 'Source language locale:',
        default: 'en',
        hint: '\nThis is the language we will translate FROM. Enter the locale code as it appears in your I18n files. Examples:\n\n  Framework    File Structure                   Enter\n  -----------  --------------------------------  --------\n  Rails        config/locales/en.yml             en\n  React        locales/en_GB.json                en_GB\n  Next.js      public/locales/en-US/common.json  en-US\n'
      }),
      outputLocales: (await promptService.input({
        message: 'Target language locales (comma-separated):',
        hint: '\nThese are the languages we will translate TO. Enter locale codes as they appear in your files:\n\n  Pattern Type        Target Files                      Enter\n  ------------------  --------------------------------  --------------------\n  Basic               de.json, fr.json, es.json          de,fr,es\n  Region-specific     fr-CA.json, es-MX.json, de-AT.json fr-CA,es-MX,de-AT\n  Directory-based     /locales/ja/, /locales/zh/         ja,zh\n'
      })).split(',').map(lang => lang.trim()).filter(Boolean)
    };
  } else {
    // existingProject is guaranteed to exist here since !existingProject was false
    const project = existingProject as ProjectDetails;
    config = {
      projectName: project.name,
      sourceLocale: project.source_language,
      outputLocales: project.target_languages
    };
  }

  const commonPaths = projectDefaults.defaults.commonPaths || [];
  const existingDirs: string[] = [];

  for (const dir of commonPaths) {
    if (await directoryExists(dir)) {
      existingDirs.push(dir);
    }
  }

  const projectTypeName = projectDefaults.type == 'generic' ? 'project' : `${projectDefaults.type} project`;
  let dirHint = `\nEnter the directory containing the I18n translation files for your ${projectTypeName}.`;

  if (existingDirs.length > 0) {
    dirHint += `\n  Found existing directories:\n  • ${existingDirs.map(d => `${d}/`).join('\n  • ')}\n`;
  } else {
    dirHint += `\n  Common paths:\n  • ${commonPaths.slice(0, 3).map(d => `${d}/`).join('\n  • ')}\n`;
  }

  const translationPath = await promptService.input({
    message: 'Translation files path:',
    default: projectDefaults.defaults.translationPath,
    hint: dirHint
  });

  const filePattern = projectDefaults.defaults.filePattern;

  const defaultIgnorePaths = projectDefaults.defaults.ignorePaths || [];
  const ignorePaths = await promptService.input({
    message: 'Paths to ignore (comma-separated, leave empty for none):',
    hint: '  Example: locales/ignored,locales/temp',
    default: defaultIgnorePaths.join(', ')
  });

  if (!existingProject) {
    try {
      newProject = await projectService.createProject({
        name: config.projectName,
        sourceLocale: config.sourceLocale,
        targetLocales: config.outputLocales
      });
      projectId = newProject.id;
      projectUrl = newProject.url;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(chalk.red(`\n✗ Failed to create project: ${errorMessage}`));
      return null;
    }
  } else {
    const project = existingProject as ProjectDetails;
    projectId = project.id;
    projectUrl = project.url;
  }

  return {
    projectId,
    sourceLocale: config.sourceLocale,
    outputLocales: config.outputLocales,
    translationPath,
    filePattern,
    ignorePaths: ignorePaths.split(',').map(p => p.trim()).filter(Boolean),
    newProject: !existingProject,
    url: projectUrl
  };
}

export async function init(deps: InitDependencies = {}): Promise<void> {
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

  const requiredDeps = {
    console,
    basePath,
    promptService,
    configUtils,
    authUtils,
    importUtils,
    projectApi,
    login: loginFn
  };

  const existingConfig = await configUtils.getProjectConfig(basePath);

  if (existingConfig) {
    await handleExistingConfiguration(existingConfig, requiredDeps);
  } else {
    await handleNewProjectSetup(requiredDeps);
  }
}
