import { promises as fs } from 'fs';
import path from 'path';

export const SPECIAL_CHARS_REGEX = /[:@#,[\]{}?|>&*!\n]/;
export const INTERPOLATION = '%{';
export const MAX_ARRAY_LENGTH = 1000;

export async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    if (dir !== '.') {
        await fs.mkdir(dir, { recursive: true });
    }
}

export function tryParseJsonArray(value) {
    if (typeof value !== 'string' || !value.startsWith('["') || !value.endsWith('"]')) {
        return null;
    }

    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return null;
        }

        if (parsed.length > MAX_ARRAY_LENGTH) {
            console.warn(`Array length ${parsed.length} exceeds maximum allowed length of ${MAX_ARRAY_LENGTH}`);
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}