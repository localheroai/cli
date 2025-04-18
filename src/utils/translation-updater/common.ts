import { promises as fs } from 'fs';
import path from 'path';

export const SPECIAL_CHARS_REGEX = /[:@#,[\]{}?|>&*!\n]/;
export const INTERPOLATION = '%{';
export const MAX_ARRAY_LENGTH = 1000;

/**
 * Checks if a file exists at the specified path
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the directory for the provided file path exists
 */
export async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (dir !== '.') {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Attempts to parse a string as a JSON array
 * Returns the parsed array or null if parsing fails
 */
export function tryParseJsonArray(value: unknown): string[] | null {
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