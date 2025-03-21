import { jest } from '@jest/globals';

describe('auth utils', () => {
  let mockConfigService;
  let getApiKey;
  let checkAuth;
  let originalEnv;
  let originalConsole;

  beforeEach(async () => {
    jest.resetModules();
    originalEnv = process.env;
    process.env = { ...originalEnv };

    mockConfigService = {
      getAuthConfig: jest.fn()
    };

    await jest.unstable_mockModule('../../src/utils/config.js', () => ({
      configService: mockConfigService
    }));

    const authModule = await import('../../src/utils/auth.js');
    getApiKey = authModule.getApiKey;
    checkAuth = authModule.checkAuth;

    originalConsole = { ...console };
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
    console.info = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.console = originalConsole;
    jest.restoreAllMocks();
  });

  describe('getApiKey', () => {
    it('returns API key from environment variable when available', async () => {
      const envApiKey = 'tk_123456789012345678901234567890123456789012345678';
      process.env.LOCALHERO_API_KEY = envApiKey;

      const result = await getApiKey();

      expect(result).toBe(envApiKey);
      expect(mockConfigService.getAuthConfig).not.toHaveBeenCalled();
    });

    it('returns API key from config when env variable is not set', async () => {
      const configApiKey = 'tk_987654321098765432109876543210987654321098765432';
      mockConfigService.getAuthConfig.mockResolvedValue({ api_key: configApiKey });

      const result = await getApiKey();

      expect(result).toBe(configApiKey);
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });

    it('returns API key from config when env variable is empty', async () => {
      process.env.LOCALHERO_API_KEY = '';
      const configApiKey = 'tk_987654321098765432109876543210987654321098765432';
      mockConfigService.getAuthConfig.mockResolvedValue({ api_key: configApiKey });

      const result = await getApiKey();

      expect(result).toBe(configApiKey);
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });

    it('returns undefined when no API key is available', async () => {
      mockConfigService.getAuthConfig.mockResolvedValue(null);

      const result = await getApiKey();

      expect(result).toBeUndefined();
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('returns true for valid API key from environment', async () => {
      process.env.LOCALHERO_API_KEY = 'tk_123456789abcdef';

      const result = await checkAuth();

      expect(result).toBe(true);
      expect(mockConfigService.getAuthConfig).not.toHaveBeenCalled();
    });

    it('returns true for valid API key from config', async () => {
      mockConfigService.getAuthConfig.mockResolvedValue({
        api_key: 'tk_123456789abcdef'
      });

      const result = await checkAuth();

      expect(result).toBe(true);
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });

    it('returns false for invalid API key format', async () => {
      process.env.LOCALHERO_API_KEY = 'invalid_key';

      const result = await checkAuth();

      expect(result).toBe(false);
    });

    it('returns false when no API key is available', async () => {
      mockConfigService.getAuthConfig.mockResolvedValue(null);

      const result = await checkAuth();

      expect(result).toBe(false);
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });

    it('returns false when getAuthConfig throws an error', async () => {
      mockConfigService.getAuthConfig.mockRejectedValue(new Error('Config error'));

      const result = await checkAuth();

      expect(result).toBe(false);
      expect(mockConfigService.getAuthConfig).toHaveBeenCalled();
    });
  });
});