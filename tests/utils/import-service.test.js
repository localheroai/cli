import { jest } from '@jest/globals';
import path from 'path';

describe('importService', () => {
    const TEST_BASE_PATH = '/test/path';
    let mockGlob;
    let mockFs;
    let mockImportsApi;
    let importService;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();

        mockGlob = jest.fn();
        mockFs = {
            readFile: jest.fn(),
            promises: {
                readFile: jest.fn()
            }
        };
        mockImportsApi = {
            createImport: jest.fn(),
            checkImportStatus: jest.fn()
        };

        await jest.unstable_mockModule('glob', () => ({
            glob: mockGlob
        }));
        await jest.unstable_mockModule('fs', () => mockFs);
        await jest.unstable_mockModule('fs/promises', () => mockFs.promises);
        await jest.unstable_mockModule('../../src/api/imports.js', () => mockImportsApi);

        // Mock the findTranslationFiles function from files.js
        await jest.unstable_mockModule('../../src/utils/files.js', () => ({
            findTranslationFiles: jest.fn().mockImplementation((config, options) => {
                const { basePath = process.cwd() } = options || {};

                // If paths is empty, return an empty array
                if (!config.translationFiles?.paths || config.translationFiles.paths.length === 0) {
                    return [];
                }

                // Otherwise, use mockGlob to simulate file discovery
                const pattern = path.join(basePath, config.translationFiles.paths[0], '**/*.{json,yml,yaml}');
                const ignore = (config.translationFiles.ignore || []).map(i => path.join(basePath, i));

                // Call mockGlob so the tests can verify the correct arguments
                const globParams = {
                    ignore,
                    nodir: true
                };

                return mockGlob(pattern, globParams).then((files) => {
                    const processedFiles = files.map(file => {
                        const ext = path.extname(file).slice(1).toLowerCase();
                        const basename = path.basename(file, path.extname(file));
                        const locale = basename.split('.')[0] === config.sourceLocale ?
                            config.sourceLocale : basename;

                        return {
                            path: file,
                            locale,
                            format: ext === 'yml' ? 'yaml' : ext,
                            namespace: ''
                        };
                    });

                    if (options?.returnFullResult) {
                        const sourceFiles = processedFiles.filter(file => file.locale === config.sourceLocale);
                        const targetFilesByLocale = {};

                        for (const locale of (config.outputLocales || [])) {
                            targetFilesByLocale[locale] = processedFiles.filter(file => file.locale === locale);
                        }

                        return {
                            allFiles: processedFiles,
                            sourceFiles,
                            targetFilesByLocale
                        };
                    }

                    return processedFiles;
                });
            }),

            // Add the flattenTranslations function that import-service.js needs
            flattenTranslations: jest.fn().mockImplementation((obj) => {
                const result = {};
                const flatten = (obj, prefix = '') => {
                    for (const key in obj) {
                        const newKey = prefix ? `${prefix}.${key}` : key;
                        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                            flatten(obj[key], newKey);
                        } else {
                            result[newKey] = obj[key];
                        }
                    }
                };
                flatten(obj);
                return result;
            }),

            // Add other exports that might be needed
            parseFile: jest.fn().mockImplementation((content, format) => {
                try {
                    return JSON.parse(content);
                } catch (e) {
                    return { error: 'Failed to parse' };
                }
            })
        }));

        const importServiceModule = await import('../../src/utils/import-service.js');
        importService = importServiceModule.importService;
    });

    describe('findTranslationFiles', () => {
        it('finds translation files based on config', async () => {
            const config = {
                sourceLocale: 'en',
                translationFiles: {
                    paths: ['locales'],
                    ignore: ['locales/ignored']
                }
            };

            const files = [
                path.join(TEST_BASE_PATH, 'locales/en.json'),
                path.join(TEST_BASE_PATH, 'locales/fr.yml'),
                path.join(TEST_BASE_PATH, 'locales/es.yaml')
            ];

            mockGlob.mockResolvedValue(files);

            const result = await importService.findTranslationFiles(config, TEST_BASE_PATH);

            expect(mockGlob).toHaveBeenCalledWith(
                path.join(TEST_BASE_PATH, 'locales', '**/*.{json,yml,yaml}'),
                {
                    ignore: [path.join(TEST_BASE_PATH, 'locales/ignored')],
                    nodir: true
                }
            );

            expect(result).toEqual([
                { path: 'locales/en.json', language: 'en', format: 'json', namespace: '' },
                { path: 'locales/fr.yml', language: 'fr', format: 'yaml', namespace: '' },
                { path: 'locales/es.yaml', language: 'es', format: 'yaml', namespace: '' }
            ]);
        });

        it('handles empty translation paths', async () => {
            const config = {
                sourceLocale: 'en',
                translationFiles: {
                    paths: []
                }
            };

            const result = await importService.findTranslationFiles(config, TEST_BASE_PATH);
            expect(result).toEqual([]);
        });
    });

    describe('importTranslations', () => {
        const testConfig = {
            projectId: 'test-project',
            sourceLocale: 'en',
            translationFiles: {
                paths: ['locales'],
                ignore: []
            }
        };

        it('imports source and target files successfully', async () => {
            const files = [
                path.join(TEST_BASE_PATH, 'locales/en.json'),
                path.join(TEST_BASE_PATH, 'locales/fr.json')
            ];

            mockGlob.mockResolvedValue(files);
            mockFs.promises.readFile.mockImplementation((filePath) => {
                if (filePath.endsWith('en.json')) {
                    return Promise.resolve('{"hello":"Hello"}');
                }
                if (filePath.endsWith('fr.json')) {
                    return Promise.resolve('{"hello":"Bonjour"}');
                }
                return Promise.reject(new Error(`Unexpected file: ${filePath}`));
            });

            mockImportsApi.createImport.mockResolvedValue({
                status: 'completed',
                id: 'import-123'
            });

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(result.status).toBe('completed');
            expect(result.files).toEqual({
                source: [{ path: 'locales/en.json', language: 'en', format: 'json', namespace: '' }],
                target: [{ path: 'locales/fr.json', language: 'fr', format: 'json', namespace: '' }]
            });
            expect(mockImportsApi.createImport.mock.calls[0][0]).toEqual({
                projectId: 'test-project',
                translations: [
                    {
                        language: 'en',
                        format: 'json',
                        filename: 'locales/en.json',
                        content: Buffer.from('{"hello":"Hello"}').toString('base64')
                    },
                    {
                        language: 'fr',
                        format: 'json',
                        filename: 'locales/fr.json',
                        content: Buffer.from('{"hello":"Bonjour"}').toString('base64')
                    }
                ]
            });
        });

        it('handles missing source files', async () => {
            const files = [
                path.join(TEST_BASE_PATH, 'locales/fr.json'),
                path.join(TEST_BASE_PATH, 'locales/es.json')
            ];

            mockGlob.mockResolvedValue(files);

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(result.status).toBe('failed');
            expect(result.error).toMatch(/No source language files found/);
        });

        it('handles empty file list', async () => {
            mockGlob.mockResolvedValue([]);

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(result.status).toBe('no_files');
        });

        it('handles processing status with polling', async () => {
            const files = [
                path.join(TEST_BASE_PATH, 'locales/en.json')
            ];

            mockGlob.mockResolvedValue(files);
            const testContent = '{"test":"content"}';
            mockFs.promises.readFile.mockResolvedValue(testContent);

            mockImportsApi.createImport.mockResolvedValue({
                status: 'processing',
                id: 'import-123',
                poll_interval: 0
            });

            mockImportsApi.checkImportStatus
                .mockResolvedValueOnce({
                    status: 'processing',
                    id: 'import-123',
                    poll_interval: 0
                })
                .mockResolvedValueOnce({
                    status: 'completed',
                    id: 'import-123'
                });

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(mockImportsApi.checkImportStatus).toHaveBeenCalledTimes(2);
            expect(result.status).toBe('completed');
            expect(mockImportsApi.createImport.mock.calls[0][0]).toEqual({
                projectId: 'test-project',
                translations: [
                    {
                        language: 'en',
                        format: 'json',
                        filename: 'locales/en.json',
                        content: Buffer.from('{"test":"content"}').toString('base64')
                    }
                ]
            });
        });
    });
}); 