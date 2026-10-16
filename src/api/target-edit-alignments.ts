import { getApiKey } from '../utils/auth.js';
import { getApiHost } from './client.js';

export interface TargetEditTarget {
  locale: string;
  target_path: string;
  base: string | null;
  current: string;
}

export interface TargetEditItem {
  source_path: string;
  format: string;
  key: string;
  source_base: string;
  source: string;
  targets: TargetEditTarget[];
}

export interface TargetEditAlignmentParams {
  projectId: string;
  branch: string;
  jobGroupId: string;
  headSha?: string;
  items: TargetEditItem[];
}

export type TargetEditStatus =
  | 'updated'
  | 'local_fix'
  | 'no_trigger'
  | 'several_languages_edited'
  | 'reviewer_edited'
  | 'source_edited'
  | 'plural_key'
  | 'not_mainline'
  | 'key_not_found'
  | 'unsupported_format'
  | 'literal_value'
  | 'model_error';

export interface TargetEditResultItem {
  source_path: string;
  key: string;
  status: TargetEditStatus;
  trigger_locale?: string;
  trigger_value?: string;
  source?: string;
  align_locales?: string[];
  trigger_at_base?: boolean;
}

export interface TargetEditAlignmentResponse {
  enabled: boolean;
  items: TargetEditResultItem[];
}

export class TargetEditAlignmentRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TargetEditAlignmentRequestError';
    this.status = status;
  }
}

export async function createTargetEditAlignment(
  params: TargetEditAlignmentParams
): Promise<TargetEditAlignmentResponse> {
  const apiKey = await getApiKey();
  const apiHost = getApiHost();

  const response = await fetch(`${apiHost}/api/v1/projects/${params.projectId}/target_edit_alignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      branch: params.branch,
      job_group_id: params.jobGroupId,
      ...(params.headSha && { head_sha: params.headSha }),
      items: params.items
    })
  });

  const body = parseJson(await response.text());

  if (!response.ok) {
    const message = body?.error?.message || `Source update request failed with status ${response.status}`;
    throw new TargetEditAlignmentRequestError(message, response.status);
  }

  if (!body || !Array.isArray(body.items)) {
    throw new TargetEditAlignmentRequestError('Unexpected source update response from the server', response.status);
  }

  return body as TargetEditAlignmentResponse;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
