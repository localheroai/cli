import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';
import { getCurrentBranch } from '../utils/git.js';

// Source file for translation
export interface SourceFile {
  path: string;
  content: string;
  format: string;
}

// Parameters for creating a translation job
export interface CreateTranslationJobParams {
  sourceFiles: SourceFile[];
  targetLocales: string[];
  projectId: string;
  targetPaths?: Record<string, string>;
  jobGroupId?: string;
}

// Translation job response
export interface TranslationJob {
  id: string;
  status: string;
  created_at: string;
  target_languages: string[];
}

// Response from creating translation jobs
export interface TranslationJobsResponse {
  jobs: TranslationJob[];
  totalJobs: number;
  job_group?: {
    id: string;
    short_url: string;
  };
}

/**
 * Create a new translation job
 * @param params Job parameters
 * @returns The created translation jobs
 */
export async function createTranslationJob(params: CreateTranslationJobParams): Promise<TranslationJobsResponse> {
  const apiKey = await getApiKey();
  const branch = await getCurrentBranch();

  const response = await apiRequest(`/api/v1/projects/${params.projectId}/translation_jobs`, {
    method: 'POST',
    body: {
      target_languages: params.targetLocales,
      files: params.sourceFiles.map(file => ({
        path: file.path,
        content: file.content,
        format: file.format,
        target_paths: params.targetPaths
      })),
      ...(branch && { branch }),
      ...(params.jobGroupId && { job_group_id: params.jobGroupId })
    },
    apiKey
  });

  if (!response.jobs || !response.jobs.length) {
    throw new Error('No translation jobs were created');
  }

  return {
    jobs: response.jobs,
    totalJobs: response.jobs.length,
    ...(response.job_group && { job_group: response.job_group })
  };
}

// Job status response
export interface JobStatus {
  id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  target_languages: string[];
  files: Array<{
    path: string;
    format: string;
  }>;
  translations?: Record<string, any>; // Included when includeTranslations is true
}

/**
 * Check the status of a translation job
 * @param jobId The ID of the job to check
 * @param includeTranslations Whether to include translations in the response
 * @returns The job status
 */
export async function checkJobStatus(
  jobId: string,
  includeTranslations = false
): Promise<JobStatus> {
  const apiKey = await getApiKey();
  const endpoint = `/api/v1/translation_jobs/${jobId}${includeTranslations ? '?include_translations=true' : ''}`;
  return apiRequest(endpoint, { apiKey });
}

// Translation response
export interface TranslationsResponse {
  translations: Record<string, any>;
}

/**
 * Get translations for a completed job
 * @param jobId The ID of the job
 * @returns The translations
 */
export async function getTranslations(jobId: string): Promise<TranslationsResponse> {
  const apiKey = await getApiKey();
  return apiRequest(`/api/v1/translation_jobs/${jobId}/translations`, { apiKey });
}

// Parameters for getting updates
export interface GetUpdatesParams {
  since: string;
  page?: number;
  branch?: string;
}

// Translation update
export interface TranslationUpdate {
  id: string;
  key: string;
  locale: string;
  value: string;
  updated_at: string;
}

// Updates response
export interface UpdatesResponse {
  updates: TranslationUpdate[];
  meta: {
    page: number;
    total_pages: number;
    total_count: number;
  };
}

/**
 * Get translation updates for a project
 * @param projectId The ID of the project
 * @param params Parameters for the request
 * @returns The updates
 */
export async function getUpdates(
  projectId: string,
  { since, page = 1, branch }: GetUpdatesParams
): Promise<UpdatesResponse> {
  const apiKey = await getApiKey();

  if (!since) {
    throw new Error('Missing required parameter: since (ISO 8601 timestamp)');
  }

  const queryParams = new URLSearchParams({
    since,
    page: page.toString()
  });

  if (branch) {
    queryParams.set('branch', branch);
  }

  return apiRequest(`/api/v1/projects/${projectId}/updates?${queryParams}`, { apiKey });
}