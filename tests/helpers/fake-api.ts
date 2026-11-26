import { jest } from '@jest/globals';

export interface RecordedCall {
  method: string;
  path: string;
  body: any;
}

export interface FakeApi {
  calls: RecordedCall[];
  callsTo: (suffix: string, method?: string) => RecordedCall[];
  restore: () => void;
}

export interface FakeJob {
  path: string;
  language: string;
  keys: Record<string, { value: unknown }>;
}

type Responder = (call: RecordedCall, job?: FakeJob) => Response | undefined;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export function decodeContent(file: { content: string }): any {
  return JSON.parse(Buffer.from(file.content, 'base64').toString());
}

export function translatedText(value: string, language: string): string {
  return value.replace('# ', `# (${language}) `);
}

/**
 * Stands in for the Localhero API at the fetch boundary: records every request
 * and answers jobs with a marked copy of what was sent. `respond` answers first
 * when it returns a response.
 */
export function installFakeApi(respond: Responder = () => undefined): FakeApi {
  const originalFetch = global.fetch;
  const calls: RecordedCall[] = [];
  const jobs = new Map<string, FakeJob>();

  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init.method || 'GET',
      path: `${url.pathname}${url.search}`,
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(call);

    const job = call.method === 'GET' ? jobs.get(url.pathname.split('/').pop() ?? '') : undefined;
    const custom = respond(call, job);
    if (custom) return custom;

    if (call.method === 'POST' && url.pathname.endsWith('/translation_jobs')) {
      const { keys } = decodeContent(call.body.files[0]);
      return jsonResponse({
        jobs: call.body.target_languages.map((language: string) => {
          const id = `job-${jobs.size + 1}`;
          jobs.set(id, { path: call.body.files[0].path, keys, language });
          return { id, language: { code: language } };
        })
      }, 201);
    }

    if (job) {
      const data = Object.fromEntries(Object.entries(job.keys).map(([key, details]) => [
        key,
        translatedText(String(details.value), job.language)
      ]));
      return jsonResponse({ status: 'completed', language: { code: job.language }, translations: { data } });
    }

    if (url.pathname.endsWith('/settings')) {
      return jsonResponse({ settings: { target_languages: [] } });
    }

    if (url.pathname.endsWith('/pull_request_imports')) {
      const importedCount = call.body.files.reduce((sum: number, file: any) => sum + file.changes.length, 0);
      return jsonResponse({ imported_count: importedCount, skipped: [], unchanged: [] });
    }

    return jsonResponse({});
  }) as any;

  return {
    calls,
    callsTo: (suffix, method = 'POST') => calls.filter(call => call.method === method && call.path.split('?')[0].endsWith(suffix)),
    restore: () => { global.fetch = originalFetch; }
  };
}

const ENVIRONMENT = [
  'GITHUB_ACTIONS', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_REF_NAME',
  'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_ACTOR',
  'LOCALHERO_API_KEY', 'LOCALHERO_API_HOST', 'LOCALHERO_SYNC_ID', 'LOCALHERO_SYNC_VERSION'
];

export function useTestEnvironment(): () => void {
  const saved = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
  ENVIRONMENT.forEach(name => delete process.env[name]);
  process.env.LOCALHERO_API_KEY = 'tk_0123456789abcdef';
  process.env.LOCALHERO_API_HOST = 'https://api.test';

  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
