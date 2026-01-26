import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

// Translation values can be strings, arrays, or objects (from JSON parsing)
export type TranslationValue = string | string[] | Record<string, string | number | boolean>;

// Old value from PO key versioning
export interface OldValue {
  key: string;
  name: string;
  context?: string;
  superseded_at: string;
}

export interface SyncTranslation {
  key: string;
  name: string;
  context?: string;
  value: TranslationValue;
  old_values?: OldValue[];
  file_references?: string[];
  updated_at: string;
}

export interface SyncFile {
  path: string;
  language: string;
  translations: SyncTranslation[];
}

export interface PaginationMetadata {
  current_page: number;
  total_pages: number;
  total_count: number;
  next_page: number | null;
  prev_page: number | null;
  items_per_page: number;
}

export interface SyncResponse {
  sync: {
    sync_id: string;
    status: string;
    created_at: string;
    sync_url?: string;
    pr_url?: string;
    pr_number?: number;
    files: SyncFile[];
  };
  pagination: PaginationMetadata;
}

/**
 * Get sync translations from the Sync API
 * @param syncId The sync ID from localhero.json
 * @param options Optional pagination parameters
 * @returns The sync response with translations
 */
export async function getSyncTranslations(
  syncId: string,
  options: { page?: number; perPage?: number } = {}
): Promise<SyncResponse> {
  const apiKey = await getApiKey();
  const { page = 1, perPage = 500 } = options;

  const queryParams = new URLSearchParams({
    page: page.toString(),
    per_page: perPage.toString()
  });

  return apiRequest(`/api/v1/translation_syncs/${syncId}?${queryParams}`, { apiKey });
}

export interface CompleteSyncUpdateResponse {
  success: boolean;
  status: string;
}

/**
 * Mark a sync update as completed after successfully writing translation files
 * @param syncId The sync ID from localhero.json
 * @param version The sync update version number
 * @returns Response indicating success
 */
export async function completeSyncUpdate(
  syncId: string,
  version: number
): Promise<CompleteSyncUpdateResponse> {
  const apiKey = await getApiKey();

  return apiRequest(`/api/v1/translation_syncs/${syncId}/complete_update`, {
    apiKey,
    method: 'POST',
    body: { version }
  });
}
