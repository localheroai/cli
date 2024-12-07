const DEFAULT_API_HOST = 'https://api.localhero.ai';

export function getApiHost() {
    return process.env.LOCALHERO_API_HOST || DEFAULT_API_HOST;
}

export async function apiRequest(endpoint, options = {}) {
    const apiHost = getApiHost();
    const url = `${apiHost}${endpoint}`;
    const apiKey = process.env.LOCALHERO_API_KEY || options.apiKey;

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
        ...options,
        headers,
    });

    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new Error('Failed to parse API response', { cause: error });
    }

    if (!response.ok) {
        if (response.status === 401 && data?.error?.code === 'invalid_api_key') {
            const error = new Error('Your API key is invalid or has been revoked. Please run `npx localhero login` to update your API key.');
            error.code = 'invalid_api_key';
            error.data = data;
            throw error;
        }
        const errorMessage = Array.isArray(data?.errors)
            ? data.errors.map(err => typeof err === 'string' ? err : err.message).join(', ')
            : data?.error?.message || 'API request failed';
        const error = new Error(errorMessage);
        error.data = data;
        throw error;
    }

    return data;
} 