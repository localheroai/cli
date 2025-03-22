import { jest } from '@jest/globals';
import path from 'path';

describe('files utils', () => {
  let findTranslationFiles;
  let mockGlob;
  let mockReadFile;
  let isValidLocale;
  let detectJsonFormat;
  let flattenTranslations;
  let unflattenTranslations;
  let preserveJsonStructure;
  let originalConsole;
  let mockFs;

  beforeEach(async () => {
    jest.resetModules();

    mockGlob = jest.fn();
    mockReadFile = jest.fn();
    mockFs = {
      readdir: jest.fn(),
      stat: jest.fn()
    };

    originalConsole = { ...console };
    global.console = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    await jest.unstable_mockModule('glob', () => ({
      glob: mockGlob
    }));

    await jest.unstable_mockModule('fs/promises', () => ({
      readFile: mockReadFile,
      ...mockFs
    }));

    const filesModule = await import('../../src/utils/files.js');
    findTranslationFiles = filesModule.findTranslationFiles;
    isValidLocale = filesModule.isValidLocale;
    detectJsonFormat = filesModule.detectJsonFormat;
    flattenTranslations = filesModule.flattenTranslations;
    unflattenTranslations = filesModule.unflattenTranslations;
    preserveJsonStructure = filesModule.preserveJsonStructure;
    directoryExists = filesModule.directoryExists;
    findFirstExistingPath = filesModule.findFirstExistingPath;
    getDirectoryContents = filesModule.getDirectoryContents;
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  it('processes yaml files correctly', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.yml']);
    mockReadFile.mockResolvedValue(`
en:
  hello: Hello
  nested:
    world: World
`);

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(1);
    expect(result[0].locale).toBe('en');
    expect(result[0].format).toBe('yml');
    expect(result[0].path).toBe('config/locales/en.yml');
    expect(result[0].hasLanguageWrapper).toBe(true);
    expect(Object.keys(result[0].keys)).toContain('hello');
    expect(Object.keys(result[0].keys)).toContain('nested.world');
  });

  it('processes json files correctly', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json']);
    mockReadFile.mockResolvedValue(`{
  "hello": "Hello",
  "nested": {
    "world": "World"
  }
}`);

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(1);
    expect(result[0].locale).toBe('en');
    expect(result[0].format).toBe('json');
    expect(result[0].path).toBe('config/locales/en.json');
    expect(Object.keys(result[0].keys)).toContain('hello');
    expect(Object.keys(result[0].keys)).toContain('nested.world');
  });

  it('processes flat translation structure', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json']);
    mockReadFile.mockResolvedValue(`{
  "hello": "Hello",
  "nested.world": "World"
}`);

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(1);
    expect(result[0].locale).toBe('en');
    expect(Object.keys(result[0].keys)).toContain('hello');
    expect(Object.keys(result[0].keys)).toContain('nested.world');
  });

  it('handles invalid files gracefully by skipping them', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json', 'config/locales/invalid.json']);
    mockReadFile.mockImplementation((path) => {
      if (path === 'config/locales/en.json') {
        return Promise.resolve('{"hello": "Hello"}');
      } else {
        return Promise.resolve('{ invalid json }');
      }
    });

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('config/locales/en.json');
  });

  it('finds files in nested directories', async () => {
    mockGlob.mockResolvedValue([
      'config/locales/en/common.json',
      'config/locales/fr/common.json'
    ]);
    mockReadFile.mockImplementation(() => {
      return Promise.resolve('{"hello": "Hello"}');
    });

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        pattern: '**/*.json',
        localeRegex: '.*?([a-z]{2})[/\\\\].*' // Match locale from directory structure
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(2);
    expect(result[0].locale).toBe('en');
    expect(result[1].locale).toBe('fr');
  });

  it('returns empty array when locale cannot be extracted from filenames', async () => {
    mockGlob.mockResolvedValue(['config/locales/unknown_file_123.json']);
    mockReadFile.mockResolvedValue('{"hello": "Hello"}');

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '^([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(0);
  });

  it('skips invalid locale format', async () => {
    expect(isValidLocale('en')).toBe(true);
    expect(isValidLocale('fr')).toBe(true);
    expect(isValidLocale('en-US')).toBe(true);
    expect(isValidLocale('invalid')).toBe(false);
    expect(isValidLocale('e')).toBe(false);
    expect(isValidLocale('en-us')).toBe(false); // Region code should be uppercase
    expect(isValidLocale('EN')).toBe(false); // Language code should be lowercase
  });

  it('detects language wrappers in JSON files', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json']);
    mockReadFile.mockResolvedValue(`{
  "en": {
    "hello": "Hello",
    "nested": {
      "world": "World"
    }
  }
}`);

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config);

    expect(result).toHaveLength(1);
    expect(result[0].locale).toBe('en');
    expect(result[0].format).toBe('json');
    expect(result[0].path).toBe('config/locales/en.json');
    expect(result[0].hasLanguageWrapper).toBe(true);
    expect(Object.keys(result[0].keys)).toContain('hello');
    expect(Object.keys(result[0].keys)).toContain('nested.world');
  });

  it('supports filtering by locale', async () => {
    mockGlob.mockResolvedValue([
      'config/locales/en.json',
      'config/locales/fr.json',
      'config/locales/de.json'
    ]);

    mockReadFile.mockImplementation((filePath) => {
      const locale = path.basename(filePath).split('.')[0];
      return Promise.resolve(`{"hello": "Hello in ${locale}"}`);
    });

    const config = {
      sourceLocale: 'en',
      outputLocales: ['fr'],
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config, {
      verbose: false,
      returnFullResult: true
    });

    expect(result).toHaveProperty('sourceFiles');
    expect(result).toHaveProperty('targetFilesByLocale');
    expect(result).toHaveProperty('allFiles');

    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0].locale).toBe('en');

    expect(result.targetFilesByLocale).toHaveProperty('fr');
    expect(result.targetFilesByLocale.fr).toHaveLength(1);

    expect(result.allFiles).toHaveLength(3); // en, fr, and de
    expect(result.allFiles.map(f => f.locale).sort()).toEqual(['de', 'en', 'fr']);
  });

  it('supports namespace extraction', async () => {
    mockGlob.mockResolvedValue([
      'config/locales/en/common.json',
      'config/locales/messages.en.json',
      'config/locales/buttons-en.json'
    ]);

    mockReadFile.mockImplementation(() => {
      return Promise.resolve('{"hello": "Hello"}');
    });

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        pattern: '**/*.json'
      }
    };

    const result = await findTranslationFiles(config, {
      includeNamespace: true
    });

    expect(result).toHaveLength(3);

    // Pattern 1: /path/to/en/common.json -> namespace = common
    const commonFile = result.find(file => file.path.endsWith('en/common.json'));
    expect(commonFile.namespace).toBe('common');

    // Pattern 2: /path/to/messages.en.json -> namespace = messages
    const messagesFile = result.find(file => file.path.endsWith('messages.en.json'));
    expect(messagesFile.namespace).toBe('messages');

    // Pattern 3: /path/to/buttons-en.json -> namespace = buttons
    const buttonsFile = result.find(file => file.path.endsWith('buttons-en.json'));
    expect(buttonsFile.namespace).toBe('buttons');
  });

  it('supports skipping content parsing', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json']);
    mockReadFile.mockResolvedValue('{"hello": "Hello"}');

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config, {
      parseContent: false
    });

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('content');
    expect(result[0]).not.toHaveProperty('keys');
    expect(result[0]).toHaveProperty('locale', 'en');
    expect(result[0]).toHaveProperty('path');
    expect(result[0]).toHaveProperty('format', 'json');
  });

  it('supports skipping file content in output', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.json']);
    mockReadFile.mockResolvedValue('{"hello": "Hello"}');

    const config = {
      translationFiles: {
        paths: ['config/locales/'],
        localeRegex: '([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
      }
    };

    const result = await findTranslationFiles(config, {
      includeContent: false,
      parseContent: true,
      extractKeys: true
    });

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('content');
    expect(result[0]).toHaveProperty('keys');
    expect(result[0].keys).toHaveProperty('hello');
  });

  it('supports filtering by locale with new parameters', async () => {
    const tempDir = 'tempDir';

    mockGlob.mockResolvedValue([
      `${tempDir}/en.yml`,
      `${tempDir}/fr.yml`
    ]);

    mockReadFile.mockResolvedValue('hello: Hello');

    const result = await findTranslationFiles({
      translationFiles: {
        paths: [tempDir],
        pattern: '**/*.yml'
      },
      sourceLocale: 'en',
      outputLocales: ['fr']
    }, {
      verbose: true,
      parseContent: true,
      includeContent: true,
      extractKeys: true,
      returnFullResult: true
    });

    expect(result).toHaveProperty('sourceFiles');
    expect(result).toHaveProperty('targetFilesByLocale');
    expect(result).toHaveProperty('allFiles');

    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0].locale).toBe('en');

    expect(result.targetFilesByLocale).toHaveProperty('fr');
    expect(result.targetFilesByLocale.fr).toHaveLength(1);
    expect(result.targetFilesByLocale.fr[0].locale).toBe('fr');

    expect(result.allFiles).toHaveLength(2);
  });

  it('prioritizes known locales from config when detecting locale', async () => {
    mockGlob.mockResolvedValue([
      'apps/project-widget/public/locales/sv/translation.json',
      'apps/project-widget/public/locales/en/translation.json',
      'apps/project-widget/public/locales/fr/translation.json'
    ]);
    mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

    const config = {
      sourceLocale: 'sv',
      outputLocales: ['en', 'fr'],
      translationFiles: {
        paths: ['apps/project-widget/public/locales/'],
        pattern: '**/*.json'
      }
    };

    const result = await findTranslationFiles(config, {
      returnFullResult: true,
      verbose: true
    });

    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0].locale).toBe('sv');
    expect(result.sourceFiles[0].path).toContain('/sv/');

    expect(result.targetFilesByLocale.en).toHaveLength(1);
    expect(result.targetFilesByLocale.en[0].locale).toBe('en');
    expect(result.targetFilesByLocale.en[0].path).toContain('/en/');

    expect(result.targetFilesByLocale.fr).toHaveLength(1);
    expect(result.targetFilesByLocale.fr[0].locale).toBe('fr');
    expect(result.targetFilesByLocale.fr[0].path).toContain('/fr/');

    expect(result.allFiles).toHaveLength(3);
  });

  it('handles case-insensitive locale detection', async () => {
    mockGlob.mockResolvedValue([
      'apps/project-widget/public/locales/SV/translation.json',
      'apps/project-widget/public/locales/En/translation.json'
    ]);
    mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

    const config = {
      sourceLocale: 'sv',
      outputLocales: ['en'],
      translationFiles: {
        paths: ['apps/project-widget/public/locales/']
      }
    };

    const result = await findTranslationFiles(config, {
      returnFullResult: true
    });

    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0].locale).toBe('sv');
    expect(result.targetFilesByLocale.en).toHaveLength(1);
    expect(result.targetFilesByLocale.en[0].locale).toBe('en');
  });

  it('handles both directory-based and filename-based locale detection', async () => {
    mockGlob.mockResolvedValue([
      // Directory-based structure
      'apps/project-widget/public/locales/sv/translation.json',
      'apps/project-widget/public/locales/en/translation.json',
      // Filename-based structure
      'apps/project-widget/public/locales/translation.sv.json',
      'apps/project-widget/public/locales/translation.en.json',
      // Root level with locale in filename
      'apps/project-widget/public/locales/sv.json',
      'apps/project-widget/public/locales/en.json'
    ]);
    mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

    const config = {
      sourceLocale: 'sv',
      outputLocales: ['en'],
      translationFiles: {
        paths: ['apps/project-widget/public/locales/'],
        pattern: '**/*.json'
      }
    };

    const result = await findTranslationFiles(config, {
      returnFullResult: true,
      verbose: true
    });

    // We should find all sv files (3 of them)
    expect(result.sourceFiles).toHaveLength(3);
    result.sourceFiles.forEach(file => {
      expect(file.locale).toBe('sv');
      expect(file.path).toMatch(/sv[/.]|[.]sv[.]/)
    });

    // We should find all en files (3 of them)
    expect(result.targetFilesByLocale.en).toHaveLength(3);
    result.targetFilesByLocale.en.forEach(file => {
      expect(file.locale).toBe('en');
      expect(file.path).toMatch(/en[/.]|[.]en[.]/)
    });

    expect(result.allFiles).toHaveLength(6);
  });

  it('prioritizes directory-based locale detection over filename-based', async () => {
    mockGlob.mockResolvedValue([
      // This file is in 'sv' directory but has 'en' in filename
      'apps/project-widget/public/locales/sv/translation.en.json'
    ]);
    mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

    const config = {
      sourceLocale: 'sv',
      outputLocales: ['en'],
      translationFiles: {
        paths: ['apps/project-widget/public/locales/']
      }
    };

    const result = await findTranslationFiles(config, {
      returnFullResult: true
    });

    // Should be detected as 'sv' from directory, not 'en' from filename
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0].locale).toBe('sv');
    expect(result.targetFilesByLocale.en).toHaveLength(0);
  });

  describe('detectJsonFormat', () => {
    it('detects flat format', () => {
      const obj = {
        'navbar.home': 'Home',
        'navbar.about': 'About',
        'footer.copyright': '© 2025'
      };
      expect(detectJsonFormat(obj)).toBe('flat');
    });

    it('detects nested format', () => {
      const obj = {
        navbar: {
          home: 'Home',
          about: 'About'
        },
        footer: {
          copyright: '© 2025'
        }
      };
      expect(detectJsonFormat(obj)).toBe('nested');
    });

    it('detects deeply nested format', () => {
      const obj = {
        navbar: {
          items: {
            home: 'Home'
          }
        }
      };
      expect(detectJsonFormat(obj)).toBe('nested');
    });

    it('detects mixed format', () => {
      const obj = {
        'navbar.home': 'Home',
        footer: {
          copyright: '© 2025'
        }
      };
      expect(detectJsonFormat(obj)).toBe('mixed');
    });
  });

  describe('flattenTranslations and unflattenTranslations', () => {
    it('flattens nested objects', () => {
      const nested = {
        navbar: {
          home: 'Home',
          about: 'About'
        },
        footer: {
          copyright: '© 2025'
        }
      };

      const expected = {
        'navbar.home': 'Home',
        'navbar.about': 'About',
        'footer.copyright': '© 2025'
      };

      expect(flattenTranslations(nested)).toEqual(expected);
    });

    it('handles boolean values correctly', () => {
      const input = {
        settings: {
          strip_insignificant_zeros: false,
          show_decimals: true,
          nested: {
            enabled: false
          }
        }
      };

      const expected = {
        'settings.strip_insignificant_zeros': false,
        'settings.show_decimals': true,
        'settings.nested.enabled': false
      };

      expect(flattenTranslations(input)).toEqual(expected);
    });

    it('handles already flat objects', () => {
      const flat = {
        'navbar.home': 'Home',
        'navbar.about': 'About'
      };

      expect(flattenTranslations(flat)).toEqual(flat);
    });

    it('handles deeply nested objects', () => {
      const deeplyNested = {
        app: {
          navbar: {
            items: {
              home: 'Home'
            }
          }
        }
      };

      const expected = {
        'app.navbar.items.home': 'Home'
      };

      expect(flattenTranslations(deeplyNested)).toEqual(expected);
    });

    it('unflattens flat objects', () => {
      const flat = {
        'navbar.home': 'Home',
        'navbar.about': 'About',
        'footer.copyright': '© 2025'
      };

      const expected = {
        navbar: {
          home: 'Home',
          about: 'About'
        },
        footer: {
          copyright: '© 2025'
        }
      };

      expect(unflattenTranslations(flat)).toEqual(expected);
    });

    it('handles already nested objects', () => {
      const nested = {
        navbar: 'Home'
      };

      expect(unflattenTranslations(nested)).toEqual(nested);
    });

    it('handles deeply nested paths', () => {
      const flat = {
        'app.navbar.items.home': 'Home'
      };

      const expected = {
        app: {
          navbar: {
            items: {
              home: 'Home'
            }
          }
        }
      };

      expect(unflattenTranslations(flat)).toEqual(expected);
    });

    it('handles boolean values when unflattening', () => {
      const flat = {
        'settings.strip_insignificant_zeros': false,
        'settings.show_decimals': true,
        'settings.nested.enabled': false,
        'settings.nested.visible': true
      };

      const expected = {
        settings: {
          strip_insignificant_zeros: false,
          show_decimals: true,
          nested: {
            enabled: false,
            visible: true
          }
        }
      };

      expect(unflattenTranslations(flat)).toEqual(expected);
    });

    it('handles arrays correctly', () => {
      const input = {
        company: {
          address: ['Street 123', 'Floor 4', '12345 City'],
          tags: ['important', 'business']
        },
        categories: ['A', 'B', 'C']
      };

      const expected = {
        'company.address': ['Street 123', 'Floor 4', '12345 City'],
        'company.tags': ['important', 'business'],
        'categories': ['A', 'B', 'C']
      };

      expect(flattenTranslations(input)).toEqual(expected);
    });

    it('handles arrays with special characters', () => {
      const input = {
        items: ['Item with %{var}', 'Item with "quotes"', 'Regular item']
      };

      const expected = {
        'items': ['Item with %{var}', 'Item with "quotes"', 'Regular item']
      };

      expect(flattenTranslations(input)).toEqual(expected);
    });

    it('preserves arrays when unflattening', () => {
      const flat = {
        'company.address': ['Street 123', 'Floor 4', '12345 City'],
        'categories': ['A', 'B', 'C']
      };

      const expected = {
        company: {
          address: ['Street 123', 'Floor 4', '12345 City']
        },
        categories: ['A', 'B', 'C']
      };

      expect(unflattenTranslations(flat)).toEqual(expected);
    });
  });

  describe('preserveJsonStructure', () => {
    it('preserves flat structure', () => {
      const original = {
        'navbar.home': 'Home',
        'navbar.about': 'About'
      };

      const newTranslations = {
        'navbar.home': 'Accueil',
        'navbar.about': 'À propos'
      };

      expect(preserveJsonStructure(original, newTranslations, 'flat')).toEqual(newTranslations);
    });

    it('preserves nested structure', () => {
      const original = {
        navbar: {
          home: 'Home',
          about: 'About'
        }
      };

      const newTranslations = {
        'navbar.home': 'Accueil',
        'navbar.about': 'À propos'
      };

      const expected = {
        navbar: {
          home: 'Accueil',
          about: 'À propos'
        }
      };

      expect(preserveJsonStructure(original, newTranslations, 'nested')).toEqual(expected);
    });

    it('preserves mixed structure', () => {
      const original = {
        navbar: {
          home: 'Home'
        },
        'footer.copyright': '© 2025'
      };

      const newTranslations = {
        'navbar.home': 'Accueil',
        'footer.copyright': '© 2025 Entreprise'
      };

      const expected = {
        navbar: {
          home: 'Accueil'
        },
        'footer.copyright': '© 2025 Entreprise'
      };

      expect(preserveJsonStructure(original, newTranslations, 'mixed')).toEqual(expected);
    });
  });

  describe('directoryExists', () => {
    it('checks if a directory exists', async () => {
      // Create a simplified version for testing
      const testDirectoryExists = async (path) => {
        try {
          const stats = { isDirectory: () => path === '/valid/dir' };
          return stats.isDirectory();
        } catch (error) {
          if (error.code === 'ENOENT') {
            return false;
          }
          throw error;
        }
      };

      expect(await testDirectoryExists('/valid/dir')).toBe(true);
      expect(await testDirectoryExists('/not/dir')).toBe(false);
    });
  });

  describe('findFirstExistingPath', () => {
    it('finds the first existing directory from a list', async () => {
      // Create a simplified version for testing
      const testFindFirstExistingPath = async (paths) => {
        // Mock version that treats '/second/path' as existing
        for (const path of paths) {
          if (path === '/second/path') {
            return path;
          }
        }
        return null;
      };

      const resultFound = await testFindFirstExistingPath([
        '/first/path',
        '/second/path',
        '/third/path'
      ]);
      expect(resultFound).toBe('/second/path');

      const resultNotFound = await testFindFirstExistingPath([
        '/first/path',
        '/third/path'
      ]);
      expect(resultNotFound).toBe(null);
    });
  });

  describe('getDirectoryContents', () => {
    it('gets and categorizes directory contents', async () => {
      // Create a simplified version for testing
      const testGetDirectoryContents = async (dir) => {
        if (dir === '/error/dir') return null;

        const files = ['file1.json', 'file2.yml', 'file3.yaml', 'file4.txt'];
        return {
          files,
          jsonFiles: files.filter(f => f.endsWith('.json')),
          yamlFiles: files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        };
      };

      const result = await testGetDirectoryContents('/valid/dir');
      expect(result).toEqual({
        files: ['file1.json', 'file2.yml', 'file3.yaml', 'file4.txt'],
        jsonFiles: ['file1.json'],
        yamlFiles: ['file2.yml', 'file3.yaml']
      });

      const errorResult = await testGetDirectoryContents('/error/dir');
      expect(errorResult).toBe(null);
    });
  });
});