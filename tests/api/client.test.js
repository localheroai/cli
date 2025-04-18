import { jest } from '@jest/globals';
import { apiRequest, getApiHost } from '../../src/api/client.js';

describe('API Client', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();

    originalEnv = process.env;
    process.env = { ...originalEnv };
    process.env.LOCALHERO_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
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
});