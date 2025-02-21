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
                { path: 'locales/en.json', language: 'en', format: 'json' },
                { path: 'locales/fr.yml', language: 'fr', format: 'yaml' },
                { path: 'locales/es.yaml', language: 'es', format: 'yaml' }
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

            // Mock file content reading
            const enContent = Buffer.from('{"hello": "Hello"}').toString('base64');
            const frContent = Buffer.from('{"hello": "Bonjour"}').toString('base64');

            mockFs.promises.readFile.mockImplementation((filePath) => {
                if (filePath.endsWith('en.json')) {
                    return Promise.resolve('{"hello": "Hello"}');
                }
                if (filePath.endsWith('fr.json')) {
                    return Promise.resolve('{"hello": "Bonjour"}');
                }
                return Promise.reject(new Error(`Unexpected file: ${filePath}`));
            });

            mockImportsApi.createImport
                .mockResolvedValueOnce({
                    status: 'completed',
                    id: 'source-import'
                })
                .mockResolvedValueOnce({
                    status: 'completed',
                    id: 'target-import'
                });

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(result.status).toBe('completed');
            expect(result.sourceImport).toBeDefined();
            expect(result.files).toEqual({
                source: [{ path: 'locales/en.json', language: 'en', format: 'json' }],
                target: [{ path: 'locales/fr.json', language: 'fr', format: 'json' }]
            });
            expect(mockImportsApi.createImport).toHaveBeenNthCalledWith(1, {
                projectId: 'test-project',
                translations: [{
                    language: 'en',
                    format: 'json',
                    filename: 'locales/en.json',
                    content: enContent
                }]
            });
            expect(mockImportsApi.createImport).toHaveBeenNthCalledWith(2, {
                projectId: 'test-project',
                translations: [{
                    language: 'fr',
                    format: 'json',
                    filename: 'locales/fr.json',
                    content: frContent
                }]
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

            const fileContent = Buffer.from('{"test": "content"}').toString('base64');
            mockFs.promises.readFile.mockResolvedValue('{"test": "content"}');
            mockImportsApi.createImport.mockResolvedValueOnce({
                status: 'processing',
                id: 'source-import',
                poll_interval: 0
            });

            mockImportsApi.checkImportStatus
                .mockResolvedValueOnce({
                    status: 'processing',
                    id: 'source-import',
                    poll_interval: 0
                })
                .mockResolvedValueOnce({
                    status: 'completed',
                    id: 'source-import'
                });

            const result = await importService.importTranslations(testConfig, TEST_BASE_PATH);

            expect(mockImportsApi.checkImportStatus).toHaveBeenCalledTimes(2);
            expect(result.status).toBe('completed');
            expect(mockImportsApi.createImport).toHaveBeenCalledWith({
                projectId: 'test-project',
                translations: [
                    {
                        language: 'en',
                        format: 'json',
                        filename: 'locales/en.json',
                        content: fileContent
                    }
                ]
            });
        });
    });
}); 