import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export async function listProjects() {
  const apiKey = await getApiKey();
  const response = await apiRequest('/api/v1/projects', { apiKey });
  return response.projects;
}

export async function createProject(data) {
  const apiKey = await getApiKey();
  const response = await apiRequest('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      project: {
        name: data.name,
        source_language: data.sourceLocale,
        target_languages: data.targetLocales
      }
    }),
    apiKey
  });
  return response.project;
}