import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export async function createImport({ projectId, translations }) {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${projectId}/imports`, {
    method: 'POST',
    body: JSON.stringify({
      translations
    }),
    apiKey
  });
  return response;
}

export async function checkImportStatus(projectId, importId) {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${projectId}/imports/${importId}`, {
    apiKey
  });
  return response.import;
}