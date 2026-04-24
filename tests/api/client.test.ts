import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('apiRequest', () => {
  let apiRequest: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown>;
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    delete process.env.LOCALHERO_API_KEY;

    const clientModule = await import('../../src/api/client.js');
    apiRequest = clientModule.apiRequest;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeFetchResponse(opts: {
    ok: boolean;
    status: number;
    body: string;
  }) {
    return {
      ok: opts.ok,
      status: opts.status,
      text: () => Promise.resolve(opts.body),
      headers: new Headers()
    };
  }

  describe('HTML error responses (non-JSON bodies)', () => {
    it('throws a friendly message for HTML 500 responses', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: false, status: 500, body: '<!DOCTYPE html><html>Internal Server Error</html>' })
      );

      await expect(apiRequest('/api/v1/test')).rejects.toMatchObject({
        message: expect.stringMatching(/Something went wrong on our end \(HTTP 500\).*hi@localhero\.ai/s)
      });
    });

    it('throws a temporary-unavailable message for HTML 503 responses', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: false, status: 503, body: '<!DOCTYPE html><html>Service Unavailable</html>' })
      );

      await expect(apiRequest('/api/v1/test')).rejects.toMatchObject({
        message: expect.stringMatching(/temporarily unavailable.*hi@localhero\.ai/s)
      });
    });

    it('throws a friendly message for empty-body 500 responses', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: false, status: 500, body: '' })
      );

      await expect(apiRequest('/api/v1/test')).rejects.toMatchObject({
        message: expect.stringMatching(/Something went wrong on our end \(HTTP 500\).*hi@localhero\.ai/s)
      });
    });
  });

  describe('valid JSON responses (regression guards)', () => {
    it('returns parsed data for a 2xx JSON response', async () => {
      const payload = { id: 'proj_123', name: 'My Project' };
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, body: JSON.stringify(payload) })
      );

      const result = await apiRequest('/api/v1/test');

      expect(result).toEqual(payload);
    });

    it('throws the invalid-API-key message for 401 with JSON error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 401,
          body: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Bad key' } })
        })
      );

      await expect(apiRequest('/api/v1/test')).rejects.toMatchObject({
        message: expect.stringMatching(/API key is invalid/)
      });
    });

    it('throws a server-error message for 422 with JSON error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 422,
          body: JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid params' } })
        })
      );

      await expect(apiRequest('/api/v1/test')).rejects.toMatchObject({
        message: expect.stringMatching(/Invalid params/)
      });
    });
  });
});
