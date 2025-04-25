import { ApiResponseError } from '../types/index.js';

const DEFAULT_API_HOST = 'https://api.localhero.ai';

export function getApiHost(): string {
  return process.env.LOCALHERO_API_HOST || DEFAULT_API_HOST;
}

interface ApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  apiKey?: string;
}


interface NetworkError extends Error {
  code?: string;
  cause?: {
    code?: string;
  };
}

function getNetworkErrorMessage(error: NetworkError): string {
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

export async function apiRequest<T = any>(endpoint: string, options: ApiRequestOptions = {}): Promise<T> {
  const apiHost = getApiHost();
  const url = `${apiHost}${endpoint}`;
  const apiKey = process.env.LOCALHERO_API_KEY || options.apiKey;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const fetchOptions: RequestInit = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    const networkError = error as NetworkError;
    const message = getNetworkErrorMessage(networkError);
    networkError.message = message;
    (networkError as any).cliErrorMessage = message;
    throw networkError;
  }

  let data: any;
  try {
    data = await response.json();
  } catch (error) {
    const parseError = error as Error;
    const message = 'Failed to parse API response. Error: ' + error ;
    parseError.message = message;
    (parseError as any).cliErrorMessage = message;
    throw parseError;
  }

  if (!response.ok) {
    if (response.status === 401 && data?.error?.code === 'invalid_api_key') {
      const message = 'Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key.';
      const error = new ApiResponseError(message);
      error.cliErrorMessage = message;
      error.code = 'invalid_api_key';
      error.data = data;
      error.details = null;
      throw error;
    }
    const message = Array.isArray(data?.errors)
      ? data.errors.map((err: any) => typeof err === 'string' ? err : err.message).join(', ')
      : data?.error?.message || 'API request failed';
    const error = new ApiResponseError(message);
    error.cliErrorMessage = message;
    error.code = data?.error?.code || 'API_ERROR';
    error.details = data?.error?.details || null;
    error.data = data;
    throw error;
  }

  return data as T;
}