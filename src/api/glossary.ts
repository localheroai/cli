import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export interface GlossaryTerm {
  term: string;
  context: string | null;
  translation_strategy: string | null;
  case_sensitive: boolean;
  example_translations: Record<string, string>;
}

export interface GlossaryResponse {
  glossary_terms: GlossaryTerm[];
}

export async function fetchGlossaryTerms(
  projectId: string,
  search?: string
): Promise<GlossaryResponse> {
  const apiKey = await getApiKey();
  const params = search ? `?search=${encodeURIComponent(search)}` : '';

  return apiRequest(`/api/v1/projects/${projectId}/glossary_terms${params}`, { apiKey });
}
