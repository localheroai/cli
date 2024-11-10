import { jest } from '@jest/globals';
import { login } from '../../src/commands/login.js';

describe('login command', () => {
    const mockConsole = { log: jest.fn() };
    const mockPromptService = {
        getApiKey: jest.fn()
    };
    const mockVerifyApiKey = jest.fn();
    const mockSaveConfig = jest.fn();
    const mockGitUtils = {
        updateGitignore: jest.fn().mockResolvedValue(true)
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully login with valid API key', async () => {
        mockPromptService.getApiKey.mockResolvedValue('tk_123456789012345678901234567890123456789012345678');
        mockVerifyApiKey.mockResolvedValue({
            organization: {
                name: 'Test Org',
                projects: [{ name: 'Project 1' }]
            }
        });

        await login({
            console: mockConsole,
            promptService: mockPromptService,
            verifyApiKey: mockVerifyApiKey,
            saveConfig: mockSaveConfig,
            gitUtils: mockGitUtils
        });

        expect(mockSaveConfig).toHaveBeenCalled();
        expect(mockGitUtils.updateGitignore).toHaveBeenCalled();
        expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('API key verified'));
    });

    it('should throw error for invalid API key format', async () => {
        mockPromptService.getApiKey.mockResolvedValue('invalid_key');

        await expect(login({
            console: mockConsole,
            promptService: mockPromptService,
            verifyApiKey: mockVerifyApiKey,
            saveConfig: mockSaveConfig,
            gitUtils: mockGitUtils
        })).rejects.toThrow('Invalid API key format');
    });
});
