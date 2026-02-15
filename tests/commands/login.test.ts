import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { login } from '../../src/commands/login.js';

describe('login command', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock };
  let mockConfigUtils: any;
  let mockVerifyApiKey: jest.Mock;
  let mockGitUtils: any;
  let mockPromptService: any;
  let originalExit: typeof process.exit;

  const validApiKey = 'tk_' + 'a'.repeat(48);
  const successResult = {
    organization: {
      name: 'Acme Corp',
      projects: [{ id: '1', name: 'My App' }]
    }
  };

  beforeEach(() => {
    mockConsole = {
      log: jest.fn(),
      error: jest.fn()
    };

    mockConfigUtils = {
      getAuthConfig: jest.fn().mockResolvedValue(null),
      saveAuthConfig: jest.fn().mockResolvedValue(undefined),
      getProjectConfig: jest.fn().mockResolvedValue({ projectId: 'test' })
    };

    mockVerifyApiKey = jest.fn().mockResolvedValue(successResult);

    mockGitUtils = {
      updateGitignore: jest.fn().mockResolvedValue(false)
    };

    mockPromptService = {
      getApiKey: jest.fn().mockResolvedValue(validApiKey)
    };

    originalExit = process.exit;
    process.exit = jest.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.LOCALHERO_API_KEY;
  });

  describe('--api-key option', () => {
    it('uses provided API key without prompting and shows skill tip', async () => {
      await login({
        console: mockConsole as any,
        basePath: '/tmp/test',
        promptService: mockPromptService,
        verifyApiKey: mockVerifyApiKey,
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        apiKey: validApiKey
      });

      expect(mockPromptService.getApiKey).not.toHaveBeenCalled();
      expect(mockVerifyApiKey).toHaveBeenCalledWith(validApiKey);

      const allOutput = mockConsole.log.mock.calls.map((c: any) => c[0]).join('\n');
      expect(allOutput).toContain('Acme Corp');
      expect(allOutput).toContain('localheroai/agent-skill');
    });
  });
});
