const DEFAULT_API_HOST = 'https://api.localhero.ai';

export function getApiHost() {
  return process.env.LOCALHERO_API_HOST || DEFAULT_API_HOST;
}

function getNetworkErrorMessage(error) {
  if (error.code === 'ECONNREFUSED') {
    return `Unable to connect to ${getApiHost()}. Please check your internet connection and try again.`;
  }
  if (error.cause?.code === 'ENOTFOUND') {
    return `Could not resolve host ${getApiHost()}. Please check your internet connection and try again.`;
  }
  if (error.cause?.code === 'ETIMEDOUT') {
    return `Connection to ${getApiHost()} timed out. Please try again later.`;
  }
  return `Network error while connecting to ${getApiHost()}. Please check your internet connection and try again.`;
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

  const fetchOptions = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = options.body;
  }

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    const message = getNetworkErrorMessage(error);
    error.message = message;
    error.cliErrorMessage = message;
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    const message = 'Failed to parse API response';
    error.message = message;
    error.cliErrorMessage = message;
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401 && data?.error?.code === 'invalid_api_key') {
      const message = 'Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key.';
      const error = new Error(message);
      error.cliErrorMessage = message;
      error.code = 'invalid_api_key';
      error.data = data;
      throw error;
    }
    const message = Array.isArray(data?.errors)
      ? data.errors.map(err => typeof err === 'string' ? err : err.message).join(', ')
      : data?.error?.message || 'API request failed';
    const error = new Error(message);
    error.cliErrorMessage = message;
    error.code = data?.error?.code || 'API_ERROR';
    error.data = data;
    throw error;
  }

  return data;
}