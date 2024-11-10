import { jest } from '@jest/globals';
import { init } from '../../src/commands/init.js';
import chalk from 'chalk';

describe('init command', () => {
    const mockConsole = { log: jest.fn() };
    const mockPromptService = {
        getProjectSetup: jest.fn(),
        confirmLogin: jest.fn().mockResolvedValue({ shouldLogin: false }),
        select: jest.fn().mockResolvedValue('new'),
        input: jest.fn()
    };
    const mockProjectService = {
        createProject: jest.fn(),
        listProjects: jest.fn().mockResolvedValue([])
    };
    const mockConfigService = {
        getProjectConfig: jest.fn(),
        saveProjectConfig: jest.fn()
    };
    const mockAuthUtils = {
        checkAuth: jest.fn()
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthUtils.checkAuth.mockResolvedValue(true);
        mockPromptService.confirmLogin.mockResolvedValue({ shouldLogin: false });
        mockPromptService.getProjectSetup.mockResolvedValue({
            projectName: 'test-project',
            sourceLocale: 'en'
        });
        mockPromptService.input
            .mockResolvedValueOnce('es,fr')
            .mockResolvedValueOnce('locales/')
            .mockResolvedValueOnce('node_modules,dist');
    });

    it('should skip initialization if config exists', async () => {
        mockConfigService.getProjectConfig.mockResolvedValue({ exists: true });

        await init({
            console: mockConsole,
            promptService: mockPromptService,
            projectService: mockProjectService,
            configService: mockConfigService,
            authUtils: mockAuthUtils
        });

        expect(mockConsole.log).toHaveBeenCalledWith(
            expect.stringContaining('already exists')
        );
        expect(mockPromptService.getProjectSetup).not.toHaveBeenCalled();
    });

    it('should create new project configuration', async () => {
        mockConfigService.getProjectConfig.mockResolvedValue(null);
        mockAuthUtils.checkAuth.mockResolvedValue(true);
        mockPromptService.select.mockResolvedValue('new');

        // Reset mocks to ensure clean state
        mockPromptService.input.mockReset();

        // Set up the sequence of prompts
        mockPromptService.input
            .mockResolvedValueOnce('test-project')  // Project name
            .mockResolvedValueOnce('en')           // Source locale
            .mockResolvedValueOnce('es,fr')        // Target locales
            .mockResolvedValueOnce('locales/')     // Translation path
            .mockResolvedValueOnce('node_modules,dist');  // Ignore paths

        mockProjectService.createProject.mockResolvedValue({
            id: 'proj_123',
            url: 'https://localhero.ai/projects/123'
        });

        await init({
            console: mockConsole,
            promptService: mockPromptService,
            projectService: mockProjectService,
            configService: mockConfigService,
            authUtils: mockAuthUtils
        });

        expect(mockConfigService.saveProjectConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                schemaVersion: '1.0',
                projectId: 'proj_123',
                sourceLocale: 'en',
                outputLocales: ['es', 'fr'],
                translationFiles: {
                    paths: ['locales/'],
                    ignore: ['node_modules', 'dist']
                }
            }),
            expect.any(String)
        );
    });

    it('should handle authentication requirement', async () => {
        mockConfigService.getProjectConfig.mockResolvedValue(null);
        mockAuthUtils.checkAuth.mockResolvedValue(false);
        mockPromptService.confirmLogin.mockResolvedValue({ shouldLogin: false });

        await init({
            console: mockConsole,
            promptService: mockPromptService,
            projectService: mockProjectService,
            configService: mockConfigService,
            authUtils: mockAuthUtils
        });

        expect(mockConsole.log).toHaveBeenCalledWith(
            expect.stringContaining('No API key found')
        );
        expect(mockPromptService.confirmLogin).toHaveBeenCalled();
        expect(mockPromptService.getProjectSetup).not.toHaveBeenCalled();
    });

    it('should handle project type detection', async () => {
        mockConfigService.getProjectConfig.mockResolvedValue(null);
        mockPromptService.select.mockResolvedValue('new');

        // Reset mocks to ensure clean state
        mockPromptService.input.mockReset();

        // Set up the sequence of prompts
        mockPromptService.input
            .mockResolvedValueOnce('test-project')  // Project name
            .mockResolvedValueOnce('en')           // Source locale
            .mockResolvedValueOnce('es,fr')        // Target locales
            .mockResolvedValueOnce('locales/')     // Translation path
            .mockResolvedValueOnce('node_modules,dist');  // Ignore paths

        mockProjectService.createProject.mockResolvedValue({
            id: 'proj_123',
            url: 'https://localhero.ai/projects/123'
        });

        await init({
            console: mockConsole,
            promptService: mockPromptService,
            projectService: mockProjectService,
            configService: mockConfigService,
            authUtils: mockAuthUtils
        });

        expect(mockPromptService.input).toHaveBeenCalledTimes(5);
        expect(mockConfigService.saveProjectConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                schemaVersion: '1.0',
                projectId: 'proj_123',
                sourceLocale: 'en',
                outputLocales: ['es', 'fr'],
                translationFiles: {
                    paths: ['locales/'],
                    ignore: ['node_modules', 'dist']
                }
            }),
            expect.any(String)
        );
    });
});
