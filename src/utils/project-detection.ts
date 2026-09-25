import { promises as fs } from 'fs';
import { findFirstExistingPath, findFirstGettextCatalogPath, getDirectoryContents, DirectoryContents } from './files.js';

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
    extractor?: string;
    // Literal glob patterns for the GitHub Actions paths: filter.
    // Do not use brace expansion ({ts,tsx}); list one entry per extension.
    sourceCodePaths?: string[];
  };
  commonPaths?: string[];
}

type ProjectTypes = Record<string, ProjectTypeConfig>;

interface PackageDependencies {
  [key: string]: string;
}

export interface ProjectDetectionResult {
  type: string;
  defaults: {
    translationPath: string;
    filePattern: string;
    commonPaths?: string[];
    ignorePaths?: string[];
    workflow?: string;
    extractor?: string;
    // Literal glob patterns for the GitHub Actions paths: filter.
    // Do not use brace expansion ({ts,tsx}); list one entry per extension.
    sourceCodePaths?: string[];
  };
}

export const PROJECT_TYPES: ProjectTypes = {
  django: {
    directIndicators: ['manage.py'],
    defaults: {
      translationPath: 'translations/',
      // Django deletes its .pot unless makemessages runs with --keep-pot, and a stock
      // Django app has no source-locale catalog, so the kept .pot is the source file.
      filePattern: '**/*.{po,pot}',
      ignorePaths: ['**/sources/**'],
      workflow: 'django',
      extractor: 'django',
      sourceCodePaths: ['**/*.py', '**/*.html', '**/*.txt']
    },
    commonPaths: [
      'locale',
      'locales',
      'translations'
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
  phoenix: {
    directIndicators: ['mix.exs'],
    defaults: {
      translationPath: 'priv/gettext/',
      filePattern: '**/*.po',
      extractor: 'phoenix',
      // Umbrella projects keep code in apps/<app>/lib, so both shapes are watched.
      sourceCodePaths: [
        'lib/**/*.ex', 'lib/**/*.exs', 'lib/**/*.eex', 'lib/**/*.heex', 'lib/**/*.leex',
        'apps/*/lib/**/*.ex', 'apps/*/lib/**/*.exs', 'apps/*/lib/**/*.eex',
        'apps/*/lib/**/*.heex', 'apps/*/lib/**/*.leex'
      ]
    },
    commonPaths: [
      'priv/gettext',
      'apps/*/priv/gettext'
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

export async function detectProjectType(): Promise<ProjectDetectionResult> {
  for (const [type, config] of Object.entries(PROJECT_TYPES)) {
    if (!config.directIndicators?.length && !config.packageCheck) continue;

    const isFramework = await detectFramework(config);
    if (!isFramework) continue;

    if (config.commonPaths) {
      // For gettext projects the catalog check is authoritative: falling back to a
      // name-only match would re-propose the directories it just rejected (a Django
      // app named locales/, a Python package named translations/). When it finds
      // nothing, the framework default is the better answer than a wrong directory.
      const translationPath = config.defaults.extractor
        ? await findFirstGettextCatalogPath(config.commonPaths)
        : await findFirstExistingPath(config.commonPaths);
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
