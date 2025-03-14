import { jest } from '@jest/globals';
import { init } from '../../src/commands/init.js';

describe('init command', () => {
    let mockConsole;
    let configUtils;
    let authUtils;
    let promptService;
    let projectApi;
    let importUtils;
    let login;

    function createInitDeps(overrides = {}) {
        return {
            console: mockConsole,
            configUtils,
            authUtils,
            promptService,
            projectApi,
            importUtils,
            login,
            ...overrides
        };
    }

    beforeEach(() => {
        mockConsole = { log: jest.fn() };
        configUtils = {
            getProjectConfig: jest.fn(),
            saveProjectConfig: jest.fn().mockResolvedValue(true),
            getAuthConfig: jest.fn().mockResolvedValue(null),
            saveAuthConfig: jest.fn().mockResolvedValue(true),
            updateLastSyncedAt: jest.fn().mockResolvedValue(undefined)
        };
        authUtils = {
            checkAuth: jest.fn(),
            verifyApiKey: jest.fn().mockResolvedValue({
                error: null,
                organization: {
                    name: 'Test Org',
                    projects: []
                }
            })
        };
        promptService = {
            select: jest.fn(),
            input: jest.fn(),
            confirm: jest.fn(),
            getProjectSetup: jest.fn(),
            getApiKey: jest.fn()
        };
        projectApi = {
            listProjects: jest.fn(),
            createProject: jest.fn()
        };
        importUtils = {
            importTranslations: jest.fn().mockResolvedValue({ status: 'no_files' })
        };
        login = jest.fn().mockResolvedValue(true);
        jest.resetAllMocks();
    });

    it('skips initialization if configuration exists', async () => {
        configUtils.getProjectConfig.mockResolvedValue({ exists: true });
        await init(createInitDeps());

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('Existing configuration found');
        expect(promptService.getApiKey).not.toHaveBeenCalled();
    });

    it('detects when authentication is needed', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(false);

        const mockLogin = jest.fn().mockImplementation(async () => {
            throw new Error('User cancelled');
        });

        await expect(init(createInitDeps({ login: mockLogin }))).rejects.toThrow('User cancelled');

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('No API key found');
        expect(mockLogin).toHaveBeenCalled();
    });

    it('initializes project configuration successfully', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(true);
        projectApi.listProjects.mockResolvedValue([]);
        promptService.input
            .mockResolvedValueOnce('test-project')
            .mockResolvedValueOnce('en')
            .mockResolvedValueOnce('fr,es')
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('');
        projectApi.createProject.mockResolvedValue({
            id: 'proj_123',
            name: 'test-project'
        });
        promptService.confirm
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);

        await init(createInitDeps());

        expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                projectId: 'proj_123',
                sourceLocale: 'en',
                outputLocales: ['fr', 'es'],
                translationFiles: expect.objectContaining({
                    pattern: expect.any(String)
                })
            }),
            expect.any(String)
        );

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('✓ Created localhero.json');
        expect(allConsoleOutput).toContain('https://localhero.ai/projects/proj_123');
    });

    it('handles project creation failure gracefully', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(true);
        projectApi.listProjects.mockResolvedValue([]);
        promptService.input
            .mockResolvedValueOnce('test-project')
            .mockResolvedValueOnce('en')
            .mockResolvedValueOnce('fr,es')
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('');
        projectApi.createProject.mockRejectedValue(new Error('API failure'));

        await init(createInitDeps());

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('✗ Failed to create project: API failure');
        expect(configUtils.saveProjectConfig).not.toHaveBeenCalled();
    });

    it('successfully selects existing project from list', async () => {
        const testProject = {
            id: 'proj_123',
            name: 'Existing Project',
            source_language: 'en',
            target_languages: ['fr', 'es']
        };
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(true);
        projectApi.listProjects.mockResolvedValue([testProject]);
        promptService.select.mockResolvedValue(testProject.id);
        promptService.input
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('');
        promptService.confirm
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);

        await init(createInitDeps());

        expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                projectId: testProject.id,
                sourceLocale: testProject.source_language,
                outputLocales: testProject.target_languages,
                translationFiles: expect.objectContaining({
                    pattern: expect.any(String)
                })
            }),
            expect.any(String)
        );
    });

    it('handles translation import failures', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(true);
        projectApi.listProjects.mockResolvedValue([]);
        promptService.input
            .mockResolvedValueOnce('test-project')
            .mockResolvedValueOnce('en')
            .mockResolvedValueOnce('fr,es')
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('');
        projectApi.createProject.mockResolvedValue({
            id: 'proj_123',
            name: 'test-project'
        });
        promptService.confirm
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        importUtils.importTranslations.mockResolvedValue({
            status: 'failed',
            error: 'Import failed'
        });

        await init(createInitDeps());

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('✗ Failed to import translations');
        expect(allConsoleOutput).toContain('Error: Import failed');
    });

    it('displays translations URL when available', async () => {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(true);
        projectApi.listProjects.mockResolvedValue([]);
        promptService.input
            .mockResolvedValueOnce('test-project')
            .mockResolvedValueOnce('en')
            .mockResolvedValueOnce('fr,es')
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('');
        projectApi.createProject.mockResolvedValue({
            id: 'proj_123',
            name: 'test-project'
        });
        promptService.confirm
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        importUtils.importTranslations.mockResolvedValue({
            status: 'completed',
            statistics: {
                total_keys: 10,
                languages: [
                    { code: 'en', translated: 10 },
                    { code: 'fr', translated: 5 }
                ]
            },
            translations_url: 'https://localhero.ai/projects/proj_123/translations',
            files: {
                source: [{ path: 'locales/en.json', language: 'en', format: 'json', namespace: '' }],
                target: [{ path: 'locales/fr.json', language: 'fr', format: 'json', namespace: '' }]
            }
        });

        await init(createInitDeps());

        const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
        expect(allConsoleOutput).toContain('✓ Successfully imported translations');
        expect(allConsoleOutput).toContain('View your translations at: https://localhero.ai/projects/proj_123/translations');
    });
});