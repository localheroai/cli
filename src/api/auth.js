import { apiRequest } from './client.js';

export async function verifyApiKey(apiKey) {
    try {
        return await apiRequest('/api/v1/auth/verify', {
            apiKey
        });
    } catch (error) {
        return {
            error: {
                message: error.message || 'Failed to verify API key'
            }
        };
    }
} 