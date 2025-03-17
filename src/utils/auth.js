import { configService } from './config.js';

export async function getApiKey() {
  const envKey = process.env.LOCALHERO_API_KEY;
  if (typeof envKey === 'string' && envKey.trim() !== '') {
    return envKey;
  }

  const config = await configService.getAuthConfig();
  return config?.api_key;
}

export async function checkAuth() {
  try {
    const apiKey = await getApiKey();
    const isValidFormat = typeof apiKey === 'string' &&
      /^tk_[a-f0-9]+$/.test(apiKey);

    return isValidFormat;
  } catch {
    return false;
  }
}