import { apiRequest } from './client.js';
import { GitHubInstallationTokenResponse } from '../types/index.js';

export async function fetchGitHubInstallationToken(
  projectId: string
): Promise<string> {
  const response = await apiRequest<GitHubInstallationTokenResponse>(
    '/api/v1/github/installation_token',
    {
      method: 'POST',
      body: { project_id: projectId }
    }
  );

  return response.token;
}
