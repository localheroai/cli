import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';
import type { PrunableKey } from '../types/index.js';

export type { PrunableKey };

export interface TranslationPayload {
  language: string;
  format: string;
  filename: string;
  content: string;
  keys?: Array<{ name: string; context: string | null }>;
}

export interface CreateImportParams {
  projectId: string;
  translations: TranslationPayload[];
}

export interface BulkUpdateTranslationsParams {
  projectId: string;
  translations: TranslationPayload[];
  includePrunable?: boolean;
}

export interface ImportDetail {
  id: string;
  status: string;
  created_at: string;
  project_id: string;
  completed_at?: string;
  poll_interval?: number;
  statistics?: {
    created_keys: number;
    created_translations: number;
    updated_translations: number;
  };
  warnings?: string[];
  translations_url?: string;
  sourceImport?: boolean;
  prunable_keys?: PrunableKey[];
}

export interface ImportResponse {
  import: ImportDetail;
}

export async function createImport(params: CreateImportParams): Promise<ImportResponse> {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${params.projectId}/imports`, {
    method: 'POST',
    body: {
      translations: params.translations
    },
    apiKey
  });
  return response;
}

export async function bulkUpdateTranslations(params: BulkUpdateTranslationsParams): Promise<ImportResponse> {
  const apiKey = await getApiKey();
  const url = params.includePrunable
    ? `/api/v1/projects/${params.projectId}/imports?include_prunable=true`
    : `/api/v1/projects/${params.projectId}/imports`;

  const response = await apiRequest(url, {
    method: 'PATCH',
    body: {
      translations: params.translations
    },
    apiKey
  });
  return response;
}

export async function checkImportStatus(projectId: string, importId: string): Promise<ImportResponse> {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${projectId}/imports/${importId}`, {
    apiKey
  });
  return response;
}
