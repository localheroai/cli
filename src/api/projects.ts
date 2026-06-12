import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';
import { CustomLocale } from '../types/index.js';

/**
 * Project details returned from the API
 */
export interface ProjectDetails {
  id: string;
  name: string;
  source_language: string;
  target_languages: string[];
  created_at: string;
  updated_at: string;
  url: string;
}

/**
 * List all projects the user has access to
 * @returns Array of project details
 */
export async function listProjects(): Promise<ProjectDetails[]> {
  const apiKey = await getApiKey();
  const response = await apiRequest('/api/v1/projects', { apiKey });
  return response.projects;
}

/**
 * Parameters for creating a new project
 */
export interface CreateProjectParams {
  name: string;
  sourceLocale: string;
  targetLocales: string[];
  /** Declarations for non-standard locale codes, validated by the backend */
  customLocales?: CustomLocale[];
}

/**
 * Create a new project
 * @param data Project creation parameters
 * @returns The created project details
 */
export async function createProject(data: CreateProjectParams): Promise<ProjectDetails> {
  const apiKey = await getApiKey();
  const response = await apiRequest('/api/v1/projects', {
    method: 'POST',
    body: {
      project: {
        name: data.name,
        source_language: data.sourceLocale,
        target_languages: data.targetLocales,
        ...(data.customLocales?.length && {
          custom_languages: data.customLocales.map((locale) => ({
            code: locale.code,
            name: locale.name,
            base_language: locale.baseLanguage
          }))
        })
      }
    },
    apiKey
  });
  return response.project;
}

/**
 * Get details for a specific project
 * @param projectId The ID of the project to fetch
 * @returns The project details
 */
export async function getProject(projectId: string): Promise<ProjectDetails> {
  const apiKey = await getApiKey();
  const response = await apiRequest(`/api/v1/projects/${projectId}`, { apiKey });
  return response.project;
}