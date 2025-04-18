import { configService } from './config.js';
import type { AuthConfig } from '../types/index.js';

/**
 * Gets the API key from environment variable or config file
 * @returns The API key string or undefined if not found
 */
export async function getApiKey(): Promise<string | undefined> {
  const envKey = process.env.LOCALHERO_API_KEY;
  if (typeof envKey === 'string' && envKey.trim() !== '') {
    return envKey;
  }

  const config: AuthConfig | null = await configService.getAuthConfig();
  return config?.api_key;
}

/**
 * Checks if the user is authenticated with a valid API key
 * @returns Boolean indicating if a valid API key was found
 */
export async function checkAuth(): Promise<boolean> {
  try {
    const apiKey = await getApiKey();
    const isValidFormat = typeof apiKey === 'string' &&
      /^tk_[a-f0-9]+$/.test(apiKey);

    return isValidFormat;
  } catch {
    return false;
  }
}