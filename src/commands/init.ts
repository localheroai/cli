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
import { directoryExists, findFirstExistingPath, getDirectoryContents, DirectoryContents } from '../utils/files.js';
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
    sourceCodePaths?: string[];
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
    sourceCodePaths?: string[];
  };
}

export interface InitOptions {
  yes?: boolean;
  projectId?: string;
  projectName?: string;
  sourceLocale?: string;
  targetLocales?: string;
  path?: string;
  pattern?: string;
  ignore?: string;
  apiKey?: string;
  skipImport?: boolean;
  githubAction?: boolean;
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
  githubUtils?: {
    createGitHubActionFile: typeof createGitHubActionFile;
    workflowExists: typeof workflowExists;
  };
  login?: typeof login;
  options?: InitOptions;
}

export class MissingFlagsError extends Error {
  flags: string[];
  constructor(flags: string[]) {
    const hint = '\n(or use --project-id to reuse an existing project)';
    super(`Missing required flags for --yes: ${flags.join(', ')}${hint}`);
    this.name = 'MissingFlagsError';
    this.flags = flags;
  }
}

interface RawInitInputs {
  mode: 'new' | 'existing';
  existingProject?: ProjectDetails;
  projectName?: string;
  sourceLocale: string;
  outputLocales: string[];
  translationPath: string;
  filePattern: string;
  ignorePaths: string[];
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
  nextIntl: {
    directIndicators: [],
    packageCheck: {
      requires: ['next', 'next-intl']
    },
    defaults: {
      translationPath: 'messages/',
      filePattern: '**/*.json'
    },
    commonPaths: [
      'messages',
      'src/messages',
      'app/messages'
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
  lingui: {
    directIndicators: [
      'lingui.config.js',
      'lingui.config.ts',
      'lingui.config.cjs',
      'lingui.config.mjs',
      '.linguirc',
      '.linguirc.json'
    ],
    packageCheck: {
      oneOf: ['@lingui/cli', '@lingui/core', '@lingui/react', '@lingui/macro']
    },
    defaults: {
      translationPath: 'src/locales/',
      filePattern: '**/*.po',
      sourceCodePaths: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.jsx']
    },
    commonPaths: [
      'src/locales',
      'locales',
      'locale'
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
      'messages',
      'src/messages',
      'src/i18n',
      'app/i18n',
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

export function buildFilePatternFromContents(contents: DirectoryContents): string {
  const formats: string[] = [];
  if (contents.jsonFiles.length > 0) formats.push('json');
  if (contents.yamlFiles.length > 0) formats.push('yml', 'yaml');
  if (contents.poFiles.length > 0) formats.push('po');

  if (formats.length === 0) {
    return '**/*.{json,yml,yaml,po}';
  }
  if (formats.length === 1 && formats[0] !== 'yml') {
    return `**/*.${formats[0]}`;
  }
  return `**/*.{${formats.join(',')}}`;
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
          filePattern: buildFilePatternFromContents(contents)
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
  console: Console,
  githubUtils: { createGitHubActionFile: typeof createGitHubActionFile; workflowExists: typeof workflowExists },
  autoAnswer?: boolean,
  sourceCodePaths?: string[]
): Promise<WorkflowSetupResult> {
  if (githubUtils.workflowExists(basePath)) {
    console.log(chalk.green('✓ GitHub Actions workflow found'));
    console.log(chalk.yellow('\n⚠️  Remember to add your API key to repository secrets:'));
    console.log('   Name: LOCALHERO_API_KEY');
    console.log('   Value: Get from https://localhero.ai/api-keys');
    console.log('   Location: Repository Settings → Secrets and variables → Actions (On GitHub repo page)\n');
    return { created: false };
  }

  let shouldSetupGitHubAction: boolean;
  if (autoAnswer !== undefined) {
    shouldSetupGitHubAction = autoAnswer;
  } else {
    shouldSetupGitHubAction = await promptService.confirm({
      message: 'Would you like to set up GitHub Actions for automatic translations?',
      default: true
    });
  }

  if (!shouldSetupGitHubAction) {
    return { created: false };
  }

  try {
    const workflowFile = await githubUtils.createGitHubActionFile(basePath, translationPaths, sourceCodePaths);
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

function printLinguiWorkflowNotice(console: Console): void {
  console.log(chalk.yellow('\n⚠️  Lingui projects need an extract step in the workflow'));
  console.log('\nLingui generates .po files from your source code via `lingui extract`.');
  console.log('Add this step to the workflow before the localhero-action step:\n');
  console.log(chalk.gray('      - uses: actions/setup-node@v4'));
  console.log(chalk.gray('        with:'));
  console.log(chalk.gray('          node-version: \'20\''));
  console.log(chalk.gray('      - run: npm ci'));
  console.log(chalk.gray('      - run: npx lingui extract'));
  console.log('\nWithout this, the workflow will not pick up new translatable strings.\n');
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
  options: InitOptions,
  nonInteractive: boolean,
  deps: Required<Pick<InitDependencies, 'console' | 'basePath' | 'promptService' | 'configUtils' | 'authUtils' | 'importUtils' | 'projectApi' | 'githubUtils' | 'login'>>
): Promise<void> {
  const { console, basePath, promptService, authUtils, projectApi, importUtils, configUtils, githubUtils } = deps;

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

  await ensureAuthenticated(nonInteractive, options, deps);

  if (await authUtils.checkAuth()) {
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
      if (nonInteractive) {
        throw new Error('Could not verify project access against the Localhero API');
      }
      console.log(chalk.yellow('⚠️  Could not verify project access. Continuing anyway...\n'));
    }
  }

  if (existingConfig.lastSyncedAt) {
    console.log(chalk.green('✓ Translation files previously imported'));
  } else {
    let shouldImport: boolean;
    if (nonInteractive) {
      shouldImport = !options.skipImport;
    } else {
      shouldImport = await promptService.confirm({
        message: 'Would you like to import existing translation files? (recommended)',
        default: true
      });
    }

    if (shouldImport) {
      await handleImportProcess(existingConfig, basePath, importUtils, console, configUtils);
    }
  }

  const workflowResult = await handleGitHubWorkflowSetup(
    basePath,
    existingConfig.translationFiles?.paths || [''],
    promptService,
    console,
    githubUtils,
    nonInteractive ? options.githubAction === true : undefined
  );
  workflowCreated = workflowResult.created;

  displayFinalInstructions(workflowCreated, githubUtils.workflowExists(basePath), false, console);
}

async function handleNewProjectSetup(
  options: InitOptions,
  nonInteractive: boolean,
  deps: Required<Pick<InitDependencies, 'console' | 'basePath' | 'promptService' | 'configUtils' | 'authUtils' | 'importUtils' | 'projectApi' | 'githubUtils' | 'login'>>
): Promise<void> {
  const { console, basePath, promptService, projectApi, importUtils, configUtils, githubUtils } = deps;

  await ensureAuthenticated(nonInteractive, options, deps);

  if (!nonInteractive) {
    console.log('\nLet\'s set up configuration for your project.\n');
  }

  let workflowCreated = false;
  const projectDefaults = await detectProjectType();

  const inputs = nonInteractive
    ? await collectInputsFromFlags(options, projectDefaults, projectApi, console)
    : await collectInputsInteractive(projectDefaults, projectApi, promptService, console);

  const finalized = await finalizeProjectAndBuildConfig(inputs, projectDefaults, projectApi, console);
  if (!finalized) {
    return;
  }
  const { config, newProject, url } = finalized;

  await configUtils.saveProjectConfig(config, basePath);
  console.log(chalk.green('\n✓ Created localhero.json'));

  if (newProject && url) {
    console.log(chalk.green(`✓ Project created, view it at: ${url}\n`));
  }

  const workflowResult = await handleGitHubWorkflowSetup(
    basePath,
    config.translationFiles.paths.length > 0 ? config.translationFiles.paths : [''],
    promptService,
    console,
    githubUtils,
    nonInteractive ? options.githubAction === true : undefined,
    projectDefaults.defaults.sourceCodePaths
  );
  workflowCreated = workflowResult.created;

  if (workflowCreated && projectDefaults.type === 'lingui') {
    printLinguiWorkflowNotice(console);
  }

  let shouldImport: boolean;
  if (nonInteractive) {
    shouldImport = !options.skipImport;
  } else {
    shouldImport = await promptService.confirm({
      message: 'Would you like to import existing translation files? (recommended)',
      default: true
    });
  }

  let hasErrors = false;
  if (shouldImport) {
    console.log('\nSearching for translation files in:');
    console.log(`${config.translationFiles.paths.join(', ')}`);

    const importResult = await handleImportProcess(config, basePath, importUtils, console, configUtils);
    hasErrors = !importResult.success;
  }

  displayFinalInstructions(workflowCreated, githubUtils.workflowExists(basePath), hasErrors, console);
}

function normalizeTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

function parseCsv(raw?: string): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function filterSourceFromTargets(
  sourceLocale: string,
  rawTargets: string[],
  console: Console
): string[] {
  const filtered = rawTargets.filter(lang => lang !== sourceLocale);
  if (filtered.length < rawTargets.length) {
    console.log(chalk.yellow(`⚠️  Source language '${sourceLocale}' removed from target languages`));
  }
  return filtered;
}

async function collectInputsInteractive(
  projectDefaults: ProjectDetectionResult,
  projectService: { createProject: typeof createProject; listProjects: typeof listProjects },
  promptService: IPromptService,
  console: Console
): Promise<RawInitInputs> {
  const { choice: projectChoice, project: existingProject } = await promptService.selectProject(projectService);
  if (!projectChoice) {
    throw new Error('Project selection is required');
  }

  let projectName: string | undefined;
  let sourceLocale: string;
  let outputLocales: string[];

  if (!existingProject) {
    sourceLocale = await promptService.input({
      message: 'Source language locale:',
      default: 'en',
      hint: '\nThis is the language we will translate FROM. Enter the locale code as it appears in your I18n files. Examples:\n\n  Framework    File Structure                   Enter\n  -----------  --------------------------------  --------\n  Rails        config/locales/en.yml             en\n  React        locales/en_GB.json                en_GB\n  Next.js      public/locales/en-US/common.json  en-US\n'
    });

    const rawOutputLocales = parseCsv(await promptService.input({
      message: 'Target language locales (comma-separated):',
      hint: '\nThese are the languages we will translate TO. Enter locale codes as they appear in your files:\n\n  Pattern Type        Target Files                      Enter\n  ------------------  --------------------------------  --------------------\n  Basic               de.json, fr.json, es.json          de,fr,es\n  Region-specific     fr-CA.json, es-MX.json, de-AT.json fr-CA,es-MX,de-AT\n  Directory-based     /locales/ja/, /locales/zh/         ja,zh\n'
    }));

    outputLocales = filterSourceFromTargets(sourceLocale, rawOutputLocales, console);

    projectName = await promptService.input({
      message: 'Project name:',
      default: path.basename(process.cwd()),
    });
  } else {
    const project = existingProject as ProjectDetails;
    projectName = project.name;
    sourceLocale = project.source_language;
    outputLocales = project.target_languages;
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
  const ignorePathsRaw = await promptService.input({
    message: 'Paths to ignore (comma-separated, leave empty for none):',
    hint: '  Example: locales/ignored,locales/temp',
    default: defaultIgnorePaths.join(', ')
  });

  return {
    mode: existingProject ? 'existing' : 'new',
    existingProject: existingProject as ProjectDetails | undefined,
    projectName,
    sourceLocale,
    outputLocales,
    translationPath,
    filePattern,
    ignorePaths: parseCsv(ignorePathsRaw)
  };
}

async function collectInputsFromFlags(
  options: InitOptions,
  projectDefaults: ProjectDetectionResult,
  projectService: { createProject: typeof createProject; listProjects: typeof listProjects },
  console: Console
): Promise<RawInitInputs> {
  const filePattern = options.pattern ?? projectDefaults.defaults.filePattern;
  const ignorePaths = options.ignore !== undefined
    ? parseCsv(options.ignore)
    : (projectDefaults.defaults.ignorePaths ?? []);

  if (options.projectId) {
    const projects = await projectService.listProjects();
    const match = projects.find(p => p.id === options.projectId);
    if (!match) {
      throw new Error(`Project ${options.projectId} not found in your organization`);
    }

    const providedSource = options.sourceLocale;
    const providedTargets = options.targetLocales ? parseCsv(options.targetLocales) : undefined;
    const conflictsSource = providedSource !== undefined && providedSource !== match.source_language;
    const conflictsTargets = providedTargets !== undefined &&
      (providedTargets.length !== match.target_languages.length ||
       providedTargets.some(l => !match.target_languages.includes(l)));

    if (conflictsSource || conflictsTargets) {
      const warnings: string[] = [];
      if (conflictsSource) warnings.push('--source-locale');
      if (conflictsTargets) warnings.push('--target-locales');
      console.log(chalk.yellow(
        `⚠️  Ignoring ${warnings.join(' and ')}; using project '${match.name}' locales (source: ${match.source_language}, targets: ${match.target_languages.join(', ')})`
      ));
    }

    if (!options.path) {
      throw new MissingFlagsError(['--path']);
    }

    return {
      mode: 'existing',
      existingProject: match,
      projectName: match.name,
      sourceLocale: match.source_language,
      outputLocales: match.target_languages,
      translationPath: normalizeTrailingSlash(options.path),
      filePattern,
      ignorePaths
    };
  }

  const missing: string[] = [];
  if (!options.sourceLocale) missing.push('--source-locale');
  if (!options.targetLocales || parseCsv(options.targetLocales).length === 0) missing.push('--target-locales');
  if (!options.path) missing.push('--path');
  if (missing.length > 0) {
    throw new MissingFlagsError(missing);
  }

  const sourceLocale = options.sourceLocale as string;
  const outputLocales = filterSourceFromTargets(
    sourceLocale,
    parseCsv(options.targetLocales as string),
    console
  );

  if (outputLocales.length === 0) {
    throw new Error('After removing the source locale, no target locales remain');
  }

  return {
    mode: 'new',
    projectName: options.projectName ?? path.basename(process.cwd()),
    sourceLocale,
    outputLocales,
    translationPath: normalizeTrailingSlash(options.path as string),
    filePattern,
    ignorePaths
  };
}

async function finalizeProjectAndBuildConfig(
  inputs: RawInitInputs,
  projectDefaults: ProjectDetectionResult,
  projectService: { createProject: typeof createProject; listProjects: typeof listProjects },
  console: Console
): Promise<{ config: BaseProjectConfig; newProject: boolean; url: string | null } | null> {
  let projectId: string;
  let projectUrl: string | null;
  let isNewProject: boolean;

  if (inputs.mode === 'new') {
    try {
      const created = await projectService.createProject({
        name: inputs.projectName as string,
        sourceLocale: inputs.sourceLocale,
        targetLocales: inputs.outputLocales
      });
      projectId = created.id;
      projectUrl = created.url;
      isNewProject = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(chalk.red(`\n✗ Failed to create project: ${errorMessage}`));
      return null;
    }
  } else {
    const project = inputs.existingProject as ProjectDetails;
    projectId = project.id;
    projectUrl = project.url;
    isNewProject = false;
  }

  const config: BaseProjectConfig = {
    schemaVersion: '1.0',
    projectId,
    sourceLocale: inputs.sourceLocale,
    outputLocales: inputs.outputLocales,
    translationFiles: {
      paths: inputs.translationPath ? [inputs.translationPath] : [],
      pattern: inputs.filePattern || '**/*.{json,yml,yaml,po}',
      ignore: inputs.ignorePaths,
      ...(projectDefaults.defaults.workflow && { workflow: projectDefaults.defaults.workflow as 'default' | 'django' })
    },
    lastSyncedAt: null
  };

  return { config, newProject: isNewProject, url: projectUrl };
}

async function ensureAuthenticated(
  nonInteractive: boolean,
  options: InitOptions,
  deps: Required<Pick<InitDependencies, 'console' | 'basePath' | 'promptService' | 'configUtils' | 'authUtils' | 'login'>>
): Promise<void> {
  const { console, basePath, promptService, configUtils, authUtils, login: loginFn } = deps;

  if (await authUtils.checkAuth()) {
    return;
  }

  const envKey = process.env.LOCALHERO_API_KEY;
  const apiKey = options.apiKey || (envKey && envKey.length > 0 ? envKey : undefined);

  if (apiKey || !nonInteractive) {
    if (!nonInteractive && !apiKey) {
      console.log('Localhero.ai - Automate your i18n translations\n');
      console.log(chalk.yellow('No API key found. Let\'s get you authenticated.'));
    }
    await loginFn({
      console,
      basePath,
      promptService,
      configUtils,
      verifyApiKey: authUtils.verifyApiKey || verifyApiKey,
      isCalledFromInit: true,
      ...(apiKey ? { apiKey } : {})
    });
    return;
  }

  throw new Error('API key required: pass --api-key, set LOCALHERO_API_KEY, or run `localhero login` first');
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
    githubUtils = { createGitHubActionFile, workflowExists },
    login: loginFn = login,
    options = {}
  } = deps;

  const nonInteractive = options.yes === true;

  const requiredDeps = {
    console,
    basePath,
    promptService,
    configUtils,
    authUtils,
    importUtils,
    projectApi,
    githubUtils,
    login: loginFn
  };

  const existingConfig = await configUtils.getProjectConfig(basePath);

  if (existingConfig) {
    await handleExistingConfiguration(existingConfig, options, nonInteractive, requiredDeps);
  } else {
    await handleNewProjectSetup(options, nonInteractive, requiredDeps);
  }
}
