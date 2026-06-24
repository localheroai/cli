import { getApiKey } from '../utils/auth.js';
import { getApiHost } from './client.js';
import type { TargetChangeFile } from '../utils/target-changes.js';

export interface PullRequestImportParams {
  projectId: string;
  branch: string;
  jobGroupId: string;
  files: TargetChangeFile[];
}

export interface PullRequestImportResponse {
  imported_count: number;
  skipped: Array<{ path: string; key: string; reason: string }>;
  job_group?: { id: string; short_url: string };
}

export async function createPullRequestImport(
  params: PullRequestImportParams
): Promise<PullRequestImportResponse> {
  const apiKey = await getApiKey();
  const apiHost = getApiHost();

  const response = await fetch(`${apiHost}/api/v1/projects/${params.projectId}/pull_request_imports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      branch: params.branch,
      job_group_id: params.jobGroupId,
      files: params.files
    })
  });

  if (!response.ok) {
    throw new Error(`Translation ingestion failed with status ${response.status}`);
  }

  return response.json() as Promise<PullRequestImportResponse>;
}
