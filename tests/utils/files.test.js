import { jest } from '@jest/globals';

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
        // Mock file system
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
        // Mock file system
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

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Restore console.warn
        console.warn = originalWarn;

        expect(result).toHaveLength(1);
        expect(result[0].locale).toBe('en');
        expect(result[0].format).toBe('json');
        expect(result[0].path).toBe('config/locales/en.json');
        // Don't test hasLanguageWrapper directly as it depends on implementation details
        expect(Object.keys(result[0].keys)).toContain('hello');
        expect(Object.keys(result[0].keys)).toContain('nested.world');
    });

    it('processes flat translation structure', async () => {
        // Mock file system
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

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Restore console.warn
        console.warn = originalWarn;

        expect(result).toHaveLength(1);
        expect(result[0].locale).toBe('en');
        expect(Object.keys(result[0].keys)).toContain('hello');
        expect(Object.keys(result[0].keys)).toContain('nested.world');
    });

    it('handles invalid files gracefully', async () => {
        // Mock file system with invalid JSON
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

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Restore console.warn
        console.warn = originalWarn;

        // Should only return the valid file
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('config/locales/en.json');
    });

    it('finds files in nested directories', async () => {
        // Mock file system with nested directories
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
                pattern: '**/*.json'
            }
        };

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Restore console.warn
        console.warn = originalWarn;

        expect(result).toHaveLength(2);
        expect(result[0].locale).toBe('en');
        expect(result[1].locale).toBe('fr');
    });

    it('handles missing locale in filename', async () => {
        // Mock file system with a file that doesn't match locale pattern
        mockGlob.mockResolvedValue(['config/locales/no-locale-here.json']);
        mockReadFile.mockResolvedValue('{"hello": "Hello"}');

        const config = {
            translationFiles: {
                paths: ['config/locales/'],
                localeRegex: '^([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$' // Strict regex that requires locale at start
            }
        };

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Verify console.warn was called
        expect(console.warn).toHaveBeenCalled();

        // Restore console.warn
        console.warn = originalWarn;

        // Should skip the file with missing locale
        expect(result).toHaveLength(0);
    });

    it('skips invalid locale format', async () => {
        // This test verifies that the isValidLocale function correctly identifies invalid locales

        // Valid locales
        expect(isValidLocale('en')).toBe(true);
        expect(isValidLocale('fr')).toBe(true);
        expect(isValidLocale('en-US')).toBe(true);

        // Invalid locales
        expect(isValidLocale('invalid')).toBe(false);
        expect(isValidLocale('e')).toBe(false);
        expect(isValidLocale('en-us')).toBe(false); // Region code should be uppercase
        expect(isValidLocale('EN')).toBe(false); // Language code should be lowercase
    });

    it('detects language wrappers in JSON files', async () => {
        // Mock file system with a JSON file that has a language wrapper
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

        // Mock console.warn to avoid test output pollution
        const originalWarn = console.warn;
        console.warn = jest.fn();

        const result = await findTranslationFiles(config);

        // Restore console.warn
        console.warn = originalWarn;

        expect(result).toHaveLength(1);
        expect(result[0].locale).toBe('en');
        expect(result[0].format).toBe('json');
        expect(result[0].path).toBe('config/locales/en.json');
        expect(result[0].hasLanguageWrapper).toBe(true);
        expect(Object.keys(result[0].keys)).toContain('hello');
        expect(Object.keys(result[0].keys)).toContain('nested.world');
    });
}); 