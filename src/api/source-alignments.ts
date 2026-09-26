import { getApiKey } from '../utils/auth.js';
import { getApiHost } from './client.js';

export interface SourceAlignmentItem {
  source_path: string;
  target_path: string;
  format: string;
  key: string;
  previous_source: string;
  source: string;
  target_base: string | null;
  target_current: string | null;
}

export interface SourceAlignmentParams {
  projectId: string;
  branch: string;
  jobGroupId: string;
  headSha?: string;
  locale: string;
  items: SourceAlignmentItem[];
}

export interface SourceAlignmentResultItem {
  source_path: string;
  target_path: string;
  key: string;
  status: 'aligned' | 'unchanged' | 'skipped';
  value?: string;
  reason?: string;
}

export interface SourceAlignmentResponse {
  enabled: boolean;
  job_group?: { id: string; short_url: string };
  items: SourceAlignmentResultItem[];
  notices: string[];
}

export class SourceAlignmentRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SourceAlignmentRequestError';
    this.status = status;
  }
}

export async function createSourceAlignment(
  params: SourceAlignmentParams
): Promise<SourceAlignmentResponse> {
  const apiKey = await getApiKey();
  const apiHost = getApiHost();

  const response = await fetch(`${apiHost}/api/v1/projects/${params.projectId}/source_alignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      branch: params.branch,
      job_group_id: params.jobGroupId,
      ...(params.headSha && { head_sha: params.headSha }),
      locale: params.locale,
      items: params.items
    })
  });

  const body = parseJson(await response.text());

  if (!response.ok) {
    const message = body?.error?.message || `Alignment request failed with status ${response.status}`;
    throw new SourceAlignmentRequestError(message, response.status);
  }

  if (!body || !Array.isArray(body.items)) {
    throw new SourceAlignmentRequestError('Unexpected alignment response from the server', response.status);
  }

  return body as SourceAlignmentResponse;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
