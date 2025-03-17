import { apiRequest } from './client.js';

export async function verifyApiKey(apiKey) {
  try {
    return await apiRequest('/api/v1/auth/verify', {
      apiKey
    });
  } catch (error) {
    if (error.code === 'invalid_api_key') {
      return {
        error: {
          code: 'invalid_api_key',
          message: error.message
        }
      };
    }
    return {
      error: {
        code: 'verification_failed',
        message: error.message || 'Failed to verify API key'
      }
    };
  }
}