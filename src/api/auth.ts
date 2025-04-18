import { apiRequest } from './client.js';
import { ApiResponseError } from '../types/index.js';
import type { Organization } from '../types/index.js';

export interface VerifyApiKeyResult {
  error?: {
    code: string;
    message: string;
  };
  organization?: Organization;
}

export async function verifyApiKey(apiKey: string): Promise<VerifyApiKeyResult> {
  try {
    return await apiRequest('/api/v1/auth/verify', {
      apiKey
    });
  } catch (error) {
    if (error instanceof ApiResponseError) {
      return {
        error: {
          code: error.code,
          message: error.message
        }
      };
    }

    return {
      error: {
        code: (error as any).code || 'verification_failed',
        message: error instanceof Error && error.message
          ? error.message
          : 'Failed to verify API key'
      }
    };
  }
}