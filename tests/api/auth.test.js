import { jest } from '@jest/globals';

describe('auth API', () => {
  let verifyApiKey;
  let mockApiRequest;

  beforeEach(async () => {
    jest.resetModules();
    mockApiRequest = jest.fn();

    await jest.unstable_mockModule('../../src/api/client.js', () => ({
      apiRequest: mockApiRequest
    }));

    const authModule = await import('../../src/api/auth.js');
    verifyApiKey = authModule.verifyApiKey;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies API key with correct parameters', async () => {
    const mockResponse = {
      organization: {
        name: 'Test Org',
        projects: []
      }
    };

    mockApiRequest.mockResolvedValueOnce(mockResponse);

    const result = await verifyApiKey('test-key');

    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/auth/verify', {
      apiKey: 'test-key'
    });
    expect(result).toEqual(mockResponse);
  });

  it('handles invalid API key error', async () => {
    const error = new Error('Your API key is invalid');
    error.code = 'invalid_api_key';
    mockApiRequest.mockRejectedValueOnce(error);

    const result = await verifyApiKey('invalid-key');

    expect(result.error.code).toBe('invalid_api_key');
    expect(result.error.message).toBe('Your API key is invalid');
  });

  it('handles generic verification errors', async () => {
    const error = new Error('Network error');
    mockApiRequest.mockRejectedValueOnce(error);

    const result = await verifyApiKey('test-key');

    expect(result.error.code).toBe('verification_failed');
    expect(result.error.message).toBe('Network error');
  });

  it('provides default error message when no message is available', async () => {
    const error = new Error();
    error.message = null;
    mockApiRequest.mockRejectedValueOnce(error);

    const result = await verifyApiKey('test-key');

    expect(result.error.code).toBe('verification_failed');
    expect(result.error.message).toBe('Failed to verify API key');
  });
});