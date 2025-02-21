import { jest } from '@jest/globals';
import { translate } from '../../src/commands/translate.js';

describe('translate command', () => {
    let mockConsole;
    let configUtils;
    let authUtils;
    let fileUtils;
    let translationUtils;
    let syncUtils;

    function createTranslateDeps(overrides = {}) {
        return {
            console: mockConsole,
            configUtils,
            authUtils,
            fileUtils,
            translationUtils,
            syncUtils,
            ...overrides
        };
    }

    beforeAll(() => {
        jest.spyOn(process, 'exit').mockImplementation(() => { });
    });

    beforeEach(() => {
        mockConsole = { log: jest.fn(), error: jest.fn(), info: jest.fn() };
        configUtils = {
            getValidProjectConfig: jest.fn().mockResolvedValue({
                projectId: 'proj_123',
                sourceLocale: 'en',
                outputLocales: ['es'],
                translationFiles: { paths: ['locales/'] }
            }),
            updateLastSyncedAt: jest.fn().mockResolvedValue(true),
            configFilePath: jest.fn().mockReturnValue('localhero.json')
        };
        authUtils = {
            getApiKey: jest.fn().mockResolvedValue('tk_12345abcdef'),
            checkAuth: jest.fn().mockResolvedValue(true)
        };
        fileUtils = {
            findTranslationFiles: jest.fn()
        };
        translationUtils = {
            createTranslationJob: jest.fn(),
            checkJobStatus: jest.fn(),
            updateTranslationFile: jest.fn().mockResolvedValue(['world'])
        };
        syncUtils = {
            checkForUpdates: jest.fn().mockResolvedValue({ hasUpdates: false }),
            applyUpdates: jest.fn()
        };

        jest.clearAllMocks();
    });

    it('successfully translates missing keys', async () => {
        const sourceFile = {
            path: 'locales/en.yml',
            locale: 'en',
            content: Buffer.from(JSON.stringify({
                keys: {
                    'hello': { value: 'Hello' },
                    'world': { value: 'World' }
                }
            })).toString('base64')
        };
        const targetFile = {
            path: 'locales/es.yml',
            locale: 'es',
            content: Buffer.from(JSON.stringify({
                keys: {
                    'hello': { value: 'Hola' }
                }
            })).toString('base64')
        };

        fileUtils.findTranslationFiles.mockResolvedValue([sourceFile, targetFile]);
        translationUtils.createTranslationJob.mockResolvedValue({ jobs: [{ id: 'job_123' }] });
        translationUtils.checkJobStatus.mockResolvedValue({
            id: 'job_123',
            status: 'completed',
            progress: { percentage: 100 },
            language: { code: 'es' },
            translations: {
                translations: { 'world': 'Mundo' }
            }
        });

        await translate({ verbose: true }, createTranslateDeps());

        expect(configUtils.getValidProjectConfig).toHaveBeenCalled();
        expect(authUtils.checkAuth).toHaveBeenCalled();
        expect(fileUtils.findTranslationFiles).toHaveBeenCalled();
        expect(translationUtils.createTranslationJob).toHaveBeenCalledWith({
            projectId: 'proj_123',
            sourceFiles: expect.arrayContaining([
                expect.objectContaining({
                    path: 'locales/en.yml',
                    content: 'eyJrZXlzIjp7IndvcmxkIjp7InZhbHVlIjoiV29ybGQifX19'
                })
            ]),
            targetLocales: ['es']
        });
        expect(translationUtils.checkJobStatus).toHaveBeenCalledWith('job_123', true);
        expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
            'locales/es.yml',
            { 'world': 'Mundo' },
            'es'
        );

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('✓ Translations complete!');
    });

    it('handles authentication failure', async () => {
        authUtils.checkAuth.mockResolvedValue(false);

        await translate({}, createTranslateDeps());

        const allConsoleOutput = mockConsole.error.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('API key is invalid');
        expect(allConsoleOutput).toContain('npx @localheroai/cli login');
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles missing translation files', async () => {
        fileUtils.findTranslationFiles.mockResolvedValue([]);

        await translate({}, createTranslateDeps());

        const allConsoleOutput = mockConsole.error.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('No translation files found');
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles translation job failure', async () => {
        const sourceFile = {
            path: 'locales/en.yml',
            locale: 'en',
            content: Buffer.from(JSON.stringify({
                keys: { 'hello': { value: 'Hello' } }
            })).toString('base64')
        };

        fileUtils.findTranslationFiles.mockResolvedValue([sourceFile]);
        translationUtils.createTranslationJob.mockResolvedValue({ jobs: [{ id: 'job_123' }] });
        translationUtils.checkJobStatus.mockResolvedValue({
            id: 'job_123',
            status: 'failed',
            error: 'Translation service unavailable'
        });

        await translate({}, createTranslateDeps());

        const allConsoleOutput = mockConsole.error.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('Translation job failed');
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles WIP translations correctly', async () => {
        const sourceFile = {
            path: 'locales/en.yml',
            locale: 'en',
            content: Buffer.from(JSON.stringify({
                keys: {
                    'normal': { value: 'Normal' },
                    'wip': { value: '[WIP] Work in progress' },
                    'also_wip': { value: 'Also in progress [WIP]' }
                }
            })).toString('base64')
        };

        fileUtils.findTranslationFiles.mockResolvedValue([sourceFile]);
        translationUtils.createTranslationJob.mockResolvedValue({ jobs: [{ id: 'job_123' }] });
        translationUtils.checkJobStatus.mockResolvedValue({
            id: 'job_123',
            status: 'completed',
            progress: { percentage: 100 },
            language: { code: 'es' },
            translations: {
                translations: { 'normal': 'Normal ES' }
            }
        });

        await translate({ verbose: true }, createTranslateDeps());

        expect(translationUtils.createTranslationJob).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceFiles: expect.arrayContaining([
                    expect.objectContaining({
                        content: expect.not.stringContaining('[WIP]')
                    })
                ])
            })
        );
    });
}); 