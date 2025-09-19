import { ApiResponseError } from '../types/index.js';

const DEFAULT_API_HOST = 'https://api.localhero.ai';

// Retry configuration for network errors
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelay: 1000, // 1 second
  maxDelay: 8000,     // 8 seconds
  backoffFactor: 2
};

export function getApiHost(): string {
  return process.env.LOCALHERO_API_HOST || DEFAULT_API_HOST;
}

function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
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

function isRetryableError(error: NetworkError): boolean {
  if (error.code === 'ECONNREFUSED') return true;
  if (error.code === 'ECONNRESET') return true;
  if (error.code === 'ETIMEDOUT') return true;
  if (error.cause?.code === 'ENOTFOUND') return true;
  if (error.cause?.code === 'ETIMEDOUT') return true;
  if (error.cause?.code === 'ECONNRESET') return true;

  return false;
}

async function fetchWithRetry(url: string, options: RequestInit, retryCount: number = 0): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (error) {
    const networkError = error as NetworkError;

    if (isRetryableError(networkError) && retryCount < RETRY_CONFIG.maxRetries) {
      const delay = Math.min(
        RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffFactor, retryCount),
        RETRY_CONFIG.maxDelay
      );

      console.log(`Network error, retrying in ${delay / 1000}s... (attempt ${retryCount + 1}/${RETRY_CONFIG.maxRetries})`);
      await sleep(delay / 1000);
      return fetchWithRetry(url, options, retryCount + 1);
    }

    const message = getNetworkErrorMessage(networkError);
    networkError.message = message;
    (networkError as any).cliErrorMessage = message;
    throw networkError;
  }
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

  const response = await fetchWithRetry(url, fetchOptions);

  let data: any;
  try {
    data = await response.json();
  } catch (error) {
    const parseError = error as Error;
    const message = 'Failed to parse API response. Error: ' + error;
    parseError.message = message;
    (parseError as any).cliErrorMessage = message;
    throw parseError;
  }

  if (!response.ok) {
    if (response.status === 401 && data?.error?.code === 'invalid_api_key') {
      const message = 'Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key.';
      const error = new ApiResponseError(message, {
        code: 'invalid_api_key',
        data,
      });
      throw error;
    }

    if (response.status === 429 && data?.error?.code === 'rate_limit_exceeded') {
      const retryAfter = data?.error?.retry_after || 60;
      const message = data?.error?.message || 'Rate limit exceeded. Please try again later.';

      console.log(`Rate limit exceeded. Waiting ${retryAfter} seconds before retrying...`);
      await sleep(retryAfter);

      const error = new ApiResponseError(message, {
        code: 'rate_limit_exceeded',
        data,
        details: {
          retry_after: retryAfter,
          limit: data?.error?.limit,
          window: data?.error?.window
        },
      });
      throw error;
    }

    const message = Array.isArray(data?.errors)
      ? data.errors.map((err: any) => typeof err === 'string' ? err : err.message).join(', ')
      : data?.error?.message || 'API request failed';

    let cliErrorMessage = message;
    if (data?.error?.code === 'job_creation_failed') {
      cliErrorMessage = message;
    } else if (response.status === 422) {
      cliErrorMessage = `Server error: ${message}`;
    }

    const error = new ApiResponseError(message, {
      code: data?.error?.code || 'API_ERROR',
      details: data?.error?.details || null,
      data,
      cliErrorMessage
    });
    throw error;
  }

  return data as T;
}
