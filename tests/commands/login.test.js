import { jest } from '@jest/globals';
import { login } from '../../src/commands/login.js';

const validApiKey = 'tk_123456789012345678901234567890123456789012345678';

describe('login command', () => {
    const mockConsole = { log: jest.fn(), error: jest.fn() };
    const mockPromptService = { getApiKey: jest.fn() };
    const mockVerifyApiKey = jest.fn();
    const mockGitUtils = { updateGitignore: jest.fn().mockResolvedValue(true) };
    const configUtils = {
        getAuthConfig: jest.fn().mockResolvedValue(null),
        saveAuthConfig: jest.fn().mockResolvedValue(true),
        getProjectConfig: jest.fn().mockResolvedValue(null)
    };

    function createLoginDeps(overrides = {}) {
        return {
            console: mockConsole,
            promptService: mockPromptService,
            verifyApiKey: mockVerifyApiKey,
            gitUtils: mockGitUtils,
            configUtils,
            ...overrides
        };
    }

    beforeAll(() => {
        jest.spyOn(process, 'exit').mockImplementation(() => { });
    });

    it('should successfully log in with valid API key and create config', async () => {
        const mockVerificationSuccess = { organization: { name: 'Test Org', projects: [{ name: 'Project 1' }] } };

        mockPromptService.getApiKey.mockResolvedValue(validApiKey);
        mockVerifyApiKey.mockResolvedValue(mockVerificationSuccess);

        await login(createLoginDeps());

        expect(configUtils.saveAuthConfig).toHaveBeenCalledWith(
            expect.objectContaining({ api_key: validApiKey }),
            expect.any(String)
        );
        expect(mockConsole.log).toHaveBeenCalledWith(
            expect.stringContaining('✓ API key verified and saved to .localhero_key')
        );
        expect(mockConsole.log).toHaveBeenCalledWith(
            expect.stringContaining('💼️  Organization: Test Org')
        );
    });

    it('should reject API keys with invalid format before making API call', async () => {
        mockPromptService.getApiKey.mockResolvedValue('invalid');
        await expect(login(createLoginDeps()))
            .rejects
            .toThrow('Invalid API key format');
    });

    it('should handle API key verification failure with specific error', async () => {
        mockPromptService.getApiKey.mockResolvedValue(validApiKey);
        mockVerifyApiKey.mockResolvedValue({
            error: {
                code: 'invalid_api_key',
                message: 'Invalid API key'
            }
        });

        await expect(login(createLoginDeps()))
            .rejects
            .toThrow('Invalid API key');
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('successfully logs in with a valid API key', async () => {
        mockPromptService.getApiKey.mockResolvedValue(validApiKey);
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
            gitUtils: mockGitUtils,
            configUtils
        });

        expect(configUtils.saveAuthConfig).toHaveBeenCalled();
        expect(mockGitUtils.updateGitignore).toHaveBeenCalled();
        const loggedMessages = mockConsole.log.mock.calls.flat().join(' ');
        expect(loggedMessages).toContain('API key verified');
    });

    it('prints a warning if an existing API key is present', async () => {
        const existingAuthConfig = { api_key: 'tk_existing_valid_key_12345678901234567890123456789012' };
        configUtils.getAuthConfig.mockResolvedValue(existingAuthConfig);
        mockPromptService.getApiKey.mockResolvedValue(validApiKey);
        mockVerifyApiKey.mockResolvedValue({
            organization: {
                name: 'Existing Org',
                projects: [{ name: 'Project Existing' }]
            }
        });

        await login({
            console: mockConsole,
            promptService: mockPromptService,
            verifyApiKey: mockVerifyApiKey,
            gitUtils: mockGitUtils,
            configUtils
        });

        const logMessages = mockConsole.log.mock.calls.flat().join(' ');
        expect(logMessages).toContain('Warning: This will replace your existing API key');
    });
});
