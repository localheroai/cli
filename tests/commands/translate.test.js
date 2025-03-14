import { jest } from '@jest/globals';
import { translate } from '../../src/commands/translate.js';

describe('translate command', () => {
    let mockConsole;
    let configUtils;
    let authUtils;
    let fileUtils;
    let translationUtils;
    let syncService;

    function createTranslateDeps(overrides = {}) {
        return {
            console: mockConsole,
            configUtils,
            authUtils,
            fileUtils,
            translationUtils,
            syncService,
            ...overrides
        };
    }

    beforeAll(() => {
        jest.spyOn(process, 'exit').mockImplementation(() => { });
    });

    beforeEach(() => {
        mockConsole = { log: jest.fn(), error: jest.fn(), info: jest.fn() };

        configUtils = {
            getProjectConfig: jest.fn().mockResolvedValue({
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: ['locales/']
                }
            }),
            updateLastSyncedAt: jest.fn().mockResolvedValue(true)
        };

        authUtils = {
            checkAuth: jest.fn().mockResolvedValue(true)
        };

        fileUtils = {
            findTranslationFiles: jest.fn()
        };

        translationUtils = {
            createTranslationJob: jest.fn(),
            checkJobStatus: jest.fn(),
            updateTranslationFile: jest.fn().mockResolvedValue(true),
            findMissingTranslations: jest.fn().mockReturnValue({
                missingKeys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
                skippedKeys: {}
            }),
            batchKeysWithMissing: jest.fn().mockReturnValue({
                batches: [{
                    files: [{
                        path: 'locales/en.json',
                        format: 'json',
                        content: Buffer.from(JSON.stringify({
                            keys: { farewell: { value: 'Goodbye' } }
                        })).toString('base64')
                    }],
                    locales: ['fr']
                }],
                errors: []
            })
        };

        syncService = {
            checkForUpdates: jest.fn().mockResolvedValue({ hasUpdates: false }),
            applyUpdates: jest.fn().mockResolvedValue({ totalUpdates: 0, totalDeleted: 0 })
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('successfully translates missing keys', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [{
                path: 'locales/en.json',
                format: 'json',
                content: Buffer.from(JSON.stringify({
                    en: { farewell: 'Goodbye' }
                })).toString('base64')
            }],
            targetFilesByLocale: {
                fr: [{
                    path: 'locales/fr.json',
                    format: 'json',
                    content: Buffer.from(JSON.stringify({
                        fr: {}
                    })).toString('base64'),
                    locale: 'fr'
                }]
            },
            allFiles: [
                { path: 'locales/en.json', locale: 'en' },
                { path: 'locales/fr.json', locale: 'fr' }
            ]
        });

        translationUtils.createTranslationJob.mockResolvedValue({
            jobs: [{ id: 'job-123' }]
        });

        translationUtils.checkJobStatus.mockResolvedValue({
            status: 'completed',
            translations: {
                data: { farewell: 'Au revoir' }
            },
            language: { code: 'fr' },
            translations_url: 'https://localhero.ai/projects/test-project/translations'
        });

        await translate({ verbose: true }, createTranslateDeps());

        expect(syncService.checkForUpdates).toHaveBeenCalledWith({ verbose: true });
        expect(syncService.applyUpdates).not.toHaveBeenCalled();

        // Verify console output indicates success
        const consoleOutput = mockConsole.log.mock.calls
            .map(call => typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0]))
            .join('\n');

        expect(consoleOutput).toContain('Found 2 translation files');
        expect(consoleOutput).toContain('Found 1 source files for locale en');
        expect(consoleOutput).toContain('Translations complete');
        expect(consoleOutput).toContain('Updated 1 keys in 1 languages');
        expect(consoleOutput).toContain('https://localhero.ai/projects/test-project/translations');

        // Verify no errors were logged
        expect(mockConsole.error).not.toHaveBeenCalled();
    });

    it('applies updates before translating if available', async () => {
        syncService.checkForUpdates.mockResolvedValue({
            hasUpdates: true,
            updates: { someKey: 'someValue' }
        });

        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [{
                path: 'locales/en.json',
                format: 'json',
                content: Buffer.from(JSON.stringify({
                    en: { farewell: 'Goodbye' }
                })).toString('base64')
            }],
            targetFilesByLocale: { fr: [] },
            allFiles: [
                { path: 'locales/en.json', locale: 'en' }
            ]
        });

        await translate({ verbose: true }, createTranslateDeps());

        expect(syncService.checkForUpdates).toHaveBeenCalledWith({ verbose: true });
        expect(syncService.applyUpdates).toHaveBeenCalledWith(
            { someKey: 'someValue' },
            { verbose: true }
        );
    });

    it('handles authentication failure', async () => {
        authUtils.checkAuth.mockResolvedValue(false);
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [],
            targetFilesByLocale: {},
            allFiles: []
        });

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('Your API key is invalid')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles missing configuration', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [],
            targetFilesByLocale: {},
            allFiles: []
        });

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('No configuration found')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles missing translation files', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [],
            targetFilesByLocale: {},
            allFiles: []
        });

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('No translation files found')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles missing source files', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [],
            targetFilesByLocale: { fr: [] },
            allFiles: [{ path: 'locales/fr.json', locale: 'fr' }]
        });

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('No source files found for locale en')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles errors during translation job creation', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [{
                path: 'locales/en.json',
                format: 'json',
                content: Buffer.from(JSON.stringify({
                    en: { farewell: 'Goodbye' }
                })).toString('base64')
            }],
            targetFilesByLocale: { fr: [] },
            allFiles: [
                { path: 'locales/en.json', locale: 'en' }
            ]
        });

        translationUtils.createTranslationJob.mockRejectedValue(new Error('API Error'));

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('Error creating translation job: API Error')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles job status check errors', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue({
            sourceFiles: [{
                path: 'locales/en.json',
                format: 'json',
                content: Buffer.from(JSON.stringify({
                    en: { farewell: 'Goodbye' }
                })).toString('base64')
            }],
            targetFilesByLocale: { fr: [] },
            allFiles: [
                { path: 'locales/en.json', locale: 'en' }
            ]
        });

        translationUtils.createTranslationJob.mockResolvedValue({
            jobs: [{ id: 'job-123' }]
        });

        translationUtils.checkJobStatus.mockRejectedValue(new Error('Status check failed'));

        await translate({}, createTranslateDeps());

        expect(mockConsole.error).toHaveBeenCalledWith(
            expect.stringContaining('Error creating translation job: Status check failed')
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });
}); 