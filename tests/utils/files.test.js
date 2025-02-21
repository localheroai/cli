import { jest } from '@jest/globals';

describe('files utils', () => {
    let findTranslationFiles;
    let mockGlob;
    let mockReadFile;

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
    });

    it('processes yaml files correctly', async () => {
        const yamlContent = `
en:
  welcome:
    title: "Welcome"
    description: "Hello there"
  buttons:
    submit: "Submit"
`;
        mockGlob.mockResolvedValue(['/path/to/en.yml']);
        mockReadFile.mockResolvedValue(yamlContent);

        const result = await findTranslationFiles('/path/to', '([a-z]{2})\\.yml$');

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            path: '/path/to/en.yml',
            locale: 'en',
            format: 'yml',
            content: expect.any(String)
        });

        const decoded = JSON.parse(Buffer.from(result[0].content, 'base64').toString());
        expect(decoded).toEqual({
            keys: {
                'welcome.title': {
                    value: 'Welcome',
                    context: {
                        parent_keys: ['welcome'],
                        sibling_keys: {
                            'welcome.description': 'Hello there'
                        }
                    }
                },
                'welcome.description': {
                    value: 'Hello there',
                    context: {
                        parent_keys: ['welcome'],
                        sibling_keys: {
                            'welcome.title': 'Welcome'
                        }
                    }
                },
                'buttons.submit': {
                    value: 'Submit',
                    context: {
                        parent_keys: ['buttons'],
                        sibling_keys: {}
                    }
                }
            },
            metadata: {
                source_language: 'en'
            }
        });
    });

    it('processes json files correctly', async () => {
        const jsonContent = JSON.stringify({
            en: {
                welcome: {
                    title: 'Welcome',
                    description: 'Hello there'
                }
            }
        });

        mockGlob.mockResolvedValue(['/path/to/en.json']);
        mockReadFile.mockResolvedValue(jsonContent);

        const result = await findTranslationFiles('/path/to', '([a-z]{2})\\.json$');

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            path: '/path/to/en.json',
            locale: 'en',
            format: 'json',
            content: expect.any(String)
        });

        const decoded = JSON.parse(Buffer.from(result[0].content, 'base64').toString());
        expect(decoded.keys['welcome.title']).toBeDefined();
        expect(decoded.metadata.source_language).toBe('en');
    });

    it('processes flat translation structure', async () => {
        const jsonContent = JSON.stringify({
            welcome: {
                title: 'Welcome',
                description: 'Hello there'
            }
        });

        mockGlob.mockResolvedValue(['/path/to/en.json']);
        mockReadFile.mockResolvedValue(jsonContent);

        const result = await findTranslationFiles('/path/to', '([a-z]{2})\\.json$');

        const decoded = JSON.parse(Buffer.from(result[0].content, 'base64').toString());
        expect(decoded.keys['welcome.title'].value).toBe('Welcome');
    });

    it('handles invalid files gracefully', async () => {
        const invalidContent = 'invalid: yaml: content: :::';

        mockGlob.mockResolvedValue(['/path/to/en.yml', '/path/to/fr.yml']);
        mockReadFile.mockResolvedValueOnce(invalidContent);
        mockReadFile.mockResolvedValueOnce('fr:\n  welcome: "Bonjour"');

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const result = await findTranslationFiles('/path/to', '([a-z]{2})\\.yml$');

        expect(result).toHaveLength(1);
        expect(result[0].locale).toBe('fr');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping /path/to/en.yml'));

        consoleSpy.mockRestore();
    });

    it('finds files in nested directories', async () => {
        mockGlob.mockResolvedValue([
            '/path/to/locales/en.yml',
            '/path/to/locales/nested/fr.yml'
        ]);
        mockReadFile.mockResolvedValueOnce('en:\n  welcome: "Welcome"');
        mockReadFile.mockResolvedValueOnce('fr:\n  welcome: "Bonjour"');

        const result = await findTranslationFiles('/path/to', '([a-z]{2})\\.yml$');

        expect(result).toHaveLength(2);
        expect(result.map(r => r.locale)).toEqual(['en', 'fr']);
    });

    it('handles missing locale in filename', async () => {
        mockGlob.mockResolvedValue(['/path/to/translations.yml']);
        mockReadFile.mockResolvedValue('content: "test"');

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const result = await findTranslationFiles('/path/to', '^([a-z]{2})\\.yml$');

        expect(result).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not extract locale from filename'));

        consoleSpy.mockRestore();
    });

    it('handles invalid locale format', async () => {
        mockGlob.mockResolvedValue(['/path/to/eng.yml']);  // 3-letter code instead of 2
        mockReadFile.mockResolvedValue('content: "test"');

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const result = await findTranslationFiles('/path/to', '([a-z]{3})\\.yml$');

        expect(result).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Expected 2-letter language code')
        );

        consoleSpy.mockRestore();
    });
}); 