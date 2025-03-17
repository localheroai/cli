import { jest } from '@jest/globals';
import path from 'path';

describe('files utils', () => {
    let findTranslationFiles;
    let mockGlob;
    let mockReadFile;
    let isValidLocale;

    beforeEach(async () => {
        jest.resetModules();

        mockGlob = jest.fn();
        mockReadFile = jest.fn();

        await jest.unstable_mockModule('glob', () => ({
            glob: mockGlob
        }));

        await jest.unstable_mockModule('fs/promises', () => ({
            readFile: mockReadFile
        }));

        const filesModule = await import('../../src/utils/files.js');
        findTranslationFiles = filesModule.findTranslationFiles;
        isValidLocale = filesModule.isValidLocale;
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
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);
        console.warn = originalWarn;

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
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);
        console.warn = originalWarn;

        expect(result).toHaveLength(1);
        expect(result[0].locale).toBe('en');
        expect(Object.keys(result[0].keys)).toContain('hello');
        expect(Object.keys(result[0].keys)).toContain('nested.world');
    });

    it('handles invalid files gracefully', async () => {
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
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);
        console.warn = originalWarn;
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
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);
        console.warn = originalWarn;

        expect(result).toHaveLength(2);
        expect(result[0].locale).toBe('en');
        expect(result[1].locale).toBe('fr');
    });

    it('handles missing locale in filename', async () => {
        // Mock a file that doesn't contain any recognizable locale pattern
        mockGlob.mockResolvedValue(['config/locales/unknown_file_123.json']);
        mockReadFile.mockResolvedValue('{"hello": "Hello"}');

        const config = {
            translationFiles: {
                paths: ['config/locales/'],
                // This regex won't match "unknown_file_123.json"
                localeRegex: '^([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$'
            }
        };

        // Mock console methods to verify warning
        const originalWarn = console.warn;
        const mockWarn = jest.fn();
        console.warn = mockWarn;

        const result = await findTranslationFiles(config, { verbose: true });

        // Should skip files where locale can't be extracted
        expect(result).toHaveLength(0);

        // Should warn about skipped file
        expect(mockWarn).toHaveBeenCalledWith(
            expect.stringContaining('Could not extract locale from path: config/locales/unknown_file_123.json')
        );

        // Restore console method
        console.warn = originalWarn;
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
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);
        console.warn = originalWarn;

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

        // The implementation includes all files, not just source and target
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

    it('supports skippping content parsing', async () => {
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

        // Mock the glob result with the files we want to test
        mockGlob.mockResolvedValue([
            `${tempDir}/en.yml`,
            `${tempDir}/fr.yml`
        ]);

        // Mock the file content
        mockReadFile.mockResolvedValue('hello: Hello');

        // Test with the configuration
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
            'apps/kundo-widget/public/locales/sv/translation.json',
            'apps/kundo-widget/public/locales/en/translation.json',
            'apps/kundo-widget/public/locales/fr/translation.json'
        ]);
        mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

        const config = {
            sourceLocale: 'sv',
            outputLocales: ['en', 'fr'],
            translationFiles: {
                paths: ['apps/kundo-widget/public/locales/'],
                pattern: '**/*.json'
            }
        };

        const result = await findTranslationFiles(config, {
            returnFullResult: true,
            verbose: true
        });

        // Verify source files
        expect(result.sourceFiles).toHaveLength(1);
        expect(result.sourceFiles[0].locale).toBe('sv');
        expect(result.sourceFiles[0].path).toContain('/sv/');

        // Verify target files
        expect(result.targetFilesByLocale.en).toHaveLength(1);
        expect(result.targetFilesByLocale.en[0].locale).toBe('en');
        expect(result.targetFilesByLocale.en[0].path).toContain('/en/');

        expect(result.targetFilesByLocale.fr).toHaveLength(1);
        expect(result.targetFilesByLocale.fr[0].locale).toBe('fr');
        expect(result.targetFilesByLocale.fr[0].path).toContain('/fr/');

        // Verify all files were found
        expect(result.allFiles).toHaveLength(3);
    });

    it('handles case-insensitive locale detection', async () => {
        mockGlob.mockResolvedValue([
            'apps/kundo-widget/public/locales/SV/translation.json',
            'apps/kundo-widget/public/locales/En/translation.json'
        ]);
        mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

        const config = {
            sourceLocale: 'sv',
            outputLocales: ['en'],
            translationFiles: {
                paths: ['apps/kundo-widget/public/locales/']
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
            'apps/kundo-widget/public/locales/sv/translation.json',
            'apps/kundo-widget/public/locales/en/translation.json',
            // Filename-based structure
            'apps/kundo-widget/public/locales/translation.sv.json',
            'apps/kundo-widget/public/locales/translation.en.json',
            // Root level with locale in filename
            'apps/kundo-widget/public/locales/sv.json',
            'apps/kundo-widget/public/locales/en.json'
        ]);
        mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

        const config = {
            sourceLocale: 'sv',
            outputLocales: ['en'],
            translationFiles: {
                paths: ['apps/kundo-widget/public/locales/'],
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

        // Total should be 6 files
        expect(result.allFiles).toHaveLength(6);
    });

    it('prioritizes directory-based locale detection over filename-based', async () => {
        mockGlob.mockResolvedValue([
            // This file is in 'sv' directory but has 'en' in filename
            'apps/kundo-widget/public/locales/sv/translation.en.json'
        ]);
        mockReadFile.mockImplementation(() => Promise.resolve('{"hello": "Hello"}'));

        const config = {
            sourceLocale: 'sv',
            outputLocales: ['en'],
            translationFiles: {
                paths: ['apps/kundo-widget/public/locales/']
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
}); 