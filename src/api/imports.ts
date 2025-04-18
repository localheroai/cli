import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

/**
 * Parameters for creating an import
 */
export interface CreateImportParams {
  projectId: string;
  translations: any[]; // Array of translation files
}

/**
 * Parameters for bulk updating translations
 */
export interface BulkUpdateTranslationsParams {
  projectId: string;
  translations: any[]; // Array of translation files
}

/**
 * Import operation details
 */
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
}

/**
 * Import creation response
 */
export interface ImportResponse {
  import: ImportDetail;
}

/**
 * Create a new import of translations
 * @param params Import parameters
 * @returns The created import details
 */
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
  const response = await apiRequest(`/api/v1/projects/${params.projectId}/imports`, {
    method: 'PATCH',
    body: {
      translations: params.translations
    },
    apiKey
  });
  return response;
}

/**
 * Check the status of an import
 * @param projectId The ID of the project
 * @param importId The ID of the import to check
 * @returns The import status response
 */
export async function checkImportStatus(projectId: string, importId: string): Promise<ImportResponse> {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${projectId}/imports/${importId}`, {
    apiKey
  });
  return response;
}