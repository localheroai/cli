import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export interface BulkDeleteKeysParams {
  projectId: string;
  keyIds: string[];
}

export interface BulkDeleteResponse {
  deleted_count: number;
}

export async function bulkDeleteKeys(params: BulkDeleteKeysParams): Promise<BulkDeleteResponse> {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${params.projectId}/keys/bulk`, {
    method: 'DELETE',
    body: {
      key_ids: params.keyIds
    },
    apiKey
  });
  return response;
}
