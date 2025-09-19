import { jest } from '@jest/globals';
import { apiRequest, getApiHost } from '../../src/api/client.js';

describe('API Client', () => {
  let originalFetch;
  let originalEnv;
  let originalConsole;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();

    originalEnv = process.env;
    process.env = { ...originalEnv };
    process.env.LOCALHERO_API_KEY = 'test-api-key';

    originalConsole = { ...console };
    console.log = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    global.console = originalConsole;
    jest.restoreAllMocks();
  });

  it('makes API requests', async () => {
    const mockResponse = { data: 'test' };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    });

    const result = await apiRequest('/test-endpoint');

    expect(fetch).toHaveBeenCalledWith(
      `${getApiHost()}/test-endpoint`,
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-api-key'
        }
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it('throws on failed API request', async () => {
    const errorMessage = 'API request failed';
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: errorMessage } })
    });

    await expect(apiRequest('/test-endpoint'))
      .rejects
      .toThrow(errorMessage);
  });

  it('retries on network errors and eventually succeeds', async () => {
    const mockResponse = { data: 'success after retry' };
    const networkError = new Error('connect ECONNREFUSED');
    networkError.code = 'ECONNREFUSED';

    global.fetch
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

    const result = await apiRequest('/test-endpoint');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith('Network error, retrying in 1s... (attempt 1/5)');
    expect(result).toEqual(mockResponse);
  });

  it('does not retry non-retryable errors', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { code: 'invalid_api_key', message: 'Unauthorized' } })
    });

    await expect(apiRequest('/test-endpoint')).rejects.toThrow('Your API key is invalid');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });
});
