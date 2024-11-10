import { getConfig } from './config.js';
import fs from 'fs/promises';
import path from 'path';

export async function getApiKey() {
    const envKey = process.env.LOCALHERO_API_KEY;
    if (envKey) {
        return envKey;
    }

    try {
        const keyPath = path.join(process.cwd(), '.localhero_key');
        const fileContent = await fs.readFile(keyPath, 'utf8');
        const keyData = JSON.parse(fileContent);
        if (keyData?.api_key) {
            return keyData.api_key;
        }
    } catch (error) {
        // Silently fail and continue to config check
    }

    const config = await getConfig();
    return config?.api_key;
}

export async function checkAuth() {
    try {
        const apiKey = await getApiKey();
        const isValidFormat = typeof apiKey === 'string' &&
            /^tk_[a-f0-9]+$/.test(apiKey);

        return isValidFormat;
    } catch (error) {
        return false;
    }
} 