import { getApiKey } from '../utils/auth.js';
import { apiRequest } from './client.js';

export interface ProjectSettings {
  name: string;
  brand_name: string | null;
  tone_of_voice: string | null;
  content_type: string | null;
  length_preference: string | null;
  gender_handling: string | null;
  style_guide: string | null;
  source_language: { code: string; name: string };
  target_languages: Array<{ code: string; name: string }>;
}

export interface SettingsResponse {
  settings: ProjectSettings;
}

export async function fetchSettings(projectId: string): Promise<SettingsResponse> {
  const apiKey = await getApiKey();

  return apiRequest(`/api/v1/projects/${projectId}/settings`, { apiKey });
}
