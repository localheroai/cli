import { jest } from '@jest/globals';

describe('auth API', () => {
    let verifyApiKey;

    beforeEach(async () => {
        jest.resetModules();
        global.fetch = jest.fn();

        const authModule = await import('../../src/api/auth.js');
        verifyApiKey = authModule.verifyApiKey;
    });

    it('verifies API key with correct parameters', async () => {
        const mockResponse = {
            organization: {
                name: 'Test Org',
                projects: []
            }
        };

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(mockResponse)
        });

        const result = await verifyApiKey('test-key');

        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.localhero.ai/api/v1/auth/verify',
            {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-key'
                }
            }
        );
        expect(result).toEqual(mockResponse);
    });

    it('handles invalid API key response', async () => {
        const errorResponse = {
            error: {
                code: 'invalid_api_key',
                message: 'Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key.'
            }
        };

        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: () => Promise.resolve(errorResponse)
        });

        const result = await verifyApiKey('invalid-key');

        expect(result.error.code).toBe('invalid_api_key');
        expect(result.error.message).toBe('Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key.');
    });

    it('handles generic verification errors', async () => {
        const errorResponse = {
            error: {
                message: 'Network error'
            }
        };

        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: () => Promise.resolve(errorResponse)
        });

        const result = await verifyApiKey('test-key');

        expect(result.error.code).toBe('verification_failed');
        expect(result.error.message).toBe('Network error');
    });
}); 