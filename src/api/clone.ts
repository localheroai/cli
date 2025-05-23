import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';
import { promises as fs } from 'fs';
import path from 'path';

export interface CloneFileStatus {
  url: string | null;
  language: string;
  format: string;
  last_updated_at: string;
  status: 'completed' | 'generating' | 'failed';
}

export interface CloneResponse {
  [filePath: string]: CloneFileStatus;
}

export interface CloneApiResponse {
  [key: string]: CloneFileStatus | number;
}

export interface ParsedCloneResponse {
  files: CloneResponse;
  retryAfter?: number;
}

/**
 * Parse the raw API response into a structured format
 * @param rawResponse The raw API response
 * @returns Parsed response with files and retry information
 */
export function parseCloneResponse(rawResponse: CloneApiResponse): ParsedCloneResponse {
  const files: CloneResponse = {};
  let retryAfter: number | undefined;

  for (const [key, value] of Object.entries(rawResponse)) {
    if (key === 'retry_after' && typeof value === 'number') {
      retryAfter = value;
    } else if (typeof value === 'object' && value !== null) {
      files[key] = value as CloneFileStatus;
    }
  }

  return { files, retryAfter };
}

/**
 * Request clone generation for a project
 * @param projectId The ID of the project
 * @param params Clone request parameters
 * @returns The parsed clone response with file statuses
 */
export async function requestClone(projectId: string): Promise<ParsedCloneResponse> {
  const apiKey = await getApiKey();


  const rawResponse = await apiRequest(`/api/v1/projects/${projectId}/clone`, { apiKey }) as CloneApiResponse;
  return parseCloneResponse(rawResponse);
}

/**
 * Download a file from a URL to a local path
 * @param url The URL to download from
 * @param filePath The local file path to save to
 * @param deps Optional dependencies for testing
 * @returns Promise that resolves when download is complete
 */
export async function downloadFile(
  url: string,
  filePath: string,
  deps: { fs?: typeof fs; path?: typeof path; fetch?: typeof fetch } = {}
): Promise<void> {
  const { fs: fsModule = fs, path: pathModule = path, fetch: fetchFn = fetch } = deps;
  const apiKey = await getApiKey();

  if (!url) {
    throw new Error('URL is required for file download');
  }

  try {
    const response = await fetchFn(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    const dir = pathModule.dirname(filePath);

    await fsModule.mkdir(dir, { recursive: true });
    await fsModule.writeFile(filePath, content, 'utf8');
  } catch (error: any) {
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied writing to ${filePath}. Check file permissions.`);
    }
    if (error.code === 'ENOSPC') {
      throw new Error(`No space left on device when writing to ${filePath}`);
    }
    throw new Error(`Failed to download file to ${filePath}: ${error.message}`);
  }
}