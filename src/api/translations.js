import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export async function createTranslationJob({ sourceFiles, targetLocales, projectId }) {
    const apiKey = await getApiKey();
    const response = await apiRequest(`/api/v1/projects/${projectId}/translation_jobs`, {
        method: 'POST',
        body: JSON.stringify({
            target_languages: targetLocales,
            files: sourceFiles.map(file => ({
                path: file.path,
                content: file.content,
                format: file.format
            }))
        }),
        apiKey
    });

    if (!response.jobs || !response.jobs.length) {
        throw new Error('No translation jobs were created');
    }

    return {
        jobs: response.jobs,
        totalJobs: response.jobs.length
    };
}

export async function checkJobStatus(jobId, includeTranslations = false) {
    const apiKey = await getApiKey();
    const endpoint = `/api/v1/translation_jobs/${jobId}${includeTranslations ? '?include_translations=true' : ''}`;
    return apiRequest(endpoint, { apiKey });
}

export async function getTranslations(jobId) {
    const apiKey = await getApiKey();
    return apiRequest(`/api/v1/translation_jobs/${jobId}/translations`, { apiKey });
}

export async function getUpdates(projectId, { since, page = 1 }) {
    const apiKey = await getApiKey();

    if (!since) {
        throw new Error('Missing required parameter: since (ISO 8601 timestamp)');
    }

    const queryParams = new URLSearchParams({
        since,
        page: page.toString()
    });

    return apiRequest(`/api/v1/projects/${projectId}/updates?${queryParams}`, { apiKey });
} 