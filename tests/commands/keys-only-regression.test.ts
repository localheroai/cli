import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { translate } from '../../src/commands/translate.js';

const GITHUB_ENV = [
  'GITHUB_ACTIONS', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_REF_NAME',
  'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_ACTOR'
];

const config = {
  schemaVersion: '1.0',
  projectId: 'keys-only-project',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['locales/', 'web/', 'legacy/'] },
  lastSyncedAt: null
};

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(command: string): void {
  execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${command}`, { stdio: 'pipe' });
}

function decodeFiles(body: any): unknown {
  if (!Array.isArray(body?.files)) return body;
  return {
    ...body,
    files: body.files.map((file: any) => typeof file.content === 'string'
      ? { ...file, content: JSON.parse(Buffer.from(file.content, 'base64').toString()) }
      : file)
  };
}

function normalize(body: any): unknown {
  if (!body || typeof body !== 'object') return body;
  return decodeFiles({
    ...body,
    ...(body.job_group_id && { job_group_id: '<job-group>' }),
    ...(body.head_sha && { head_sha: '<head>' })
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('key files only: recorded API calls', () => {
  let directory: string;
  let originalCwd: string;
  let savedEnv: Record<string, string | undefined>;
  let calls: RecordedCall[];
  let requestedKeysByJob: Map<string, string[]>;
  const originalFetch = global.fetch;

  const deps: any = {
    console: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
    configUtils: {
      getProjectConfig: async () => structuredClone(config),
      updateLastSyncedAt: async () => undefined
    },
    authUtils: { checkAuth: async () => true }
  };

  async function runTranslate(options: Record<string, unknown>): Promise<void> {
    const actual: any = await import('../../src/commands/translate.js');
    const files: any = await import('../../src/utils/files.js');
    const translations: any = await import('../../src/api/translations.js');
    const updater: any = await import('../../src/utils/translation-updater/index.js');
    const utils: any = await import('../../src/utils/translation-utils.js');
    const settings: any = await import('../../src/api/settings.js');

    await actual.translate(options, {
      ...deps,
      settingsUtils: { fetchSettings: settings.fetchSettings },
      fileUtils: { findTranslationFiles: files.findTranslationFiles },
      translationUtils: {
        createTranslationJob: translations.createTranslationJob,
        checkJobStatus: translations.checkJobStatus,
        updateTranslationFile: updater.updateTranslationFile,
        findMissingTranslations: utils.findMissingTranslations,
        batchKeysWithMissing: utils.batchKeysWithMissing,
        findMissingTranslationsByLocale: utils.findMissingTranslationsByLocale
      },
      gitUtils: { autoCommitChanges: async () => 'no-changes' },
      execUtils: { execSync: jest.fn() }
    });
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'keys-only-')));
    process.chdir(directory);

    savedEnv = Object.fromEntries([...GITHUB_ENV, 'LOCALHERO_API_KEY', 'LOCALHERO_API_HOST'].map(name => [name, process.env[name]]));
    GITHUB_ENV.forEach(name => delete process.env[name]);
    process.env.LOCALHERO_API_KEY = 'tk_0123456789abcdef';
    process.env.LOCALHERO_API_HOST = 'https://api.test';

    calls = [];
    requestedKeysByJob = new Map();
    let jobCount = 0;

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method, path: `${url.pathname}${url.search}`, body: normalize(body) });

      if (method === 'POST' && url.pathname.endsWith('/translation_jobs')) {
        const content = JSON.parse(Buffer.from(body.files[0].content, 'base64').toString());
        const jobs = body.target_languages.map((code: string) => {
          const id = `job-${++jobCount}`;
          requestedKeysByJob.set(id, Object.keys(content.keys));
          return { id, language: { code } };
        });
        return jsonResponse({ jobs });
      }

      const job = url.pathname.match(/\/translation_jobs\/(job-\d+)$/);
      if (method === 'GET' && job) {
        const data = Object.fromEntries((requestedKeysByJob.get(job[1]) ?? []).map(key => [key, `sv ${key}`]));
        return jsonResponse({ status: 'completed', language: { code: 'sv' }, translations: { data } });
      }

      if (url.pathname.endsWith('/settings')) {
        return jsonResponse({ settings: { target_languages: [] } });
      }

      if (url.pathname.endsWith('/source_alignments')) {
        const items = body.items.map((item: any) => ({
          source_path: item.source_path,
          target_path: item.target_path,
          key: item.key,
          status: 'aligned',
          value: `sv aligned ${item.key}`
        }));
        return jsonResponse({ enabled: true, items, notices: [] });
      }

      if (url.pathname.endsWith('/pull_request_imports')) {
        return jsonResponse({ imported_count: 0, skipped: [], unchanged: [] });
      }

      return jsonResponse({});
    }) as any;

    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.exitCode = undefined;
  });

  function writeBaseFiles(): void {
    write('locales/en/common.yml', 'en:\n  greeting: Hello\n  farewell: Goodbye\n  nested:\n    title: Settings\n');
    write('locales/sv/common.yml', 'sv:\n  greeting: Hej\n');
    write('web/en/app.json', '{\n  "save": "Save",\n  "cancel": "Cancel"\n}\n');
    write('web/sv/app.json', '{\n  "save": "Spara"\n}\n');
    write('locales/en/README.md', '# Notes\n\nThis folder holds the English strings.\n');
    write('web/en/README.md', '# Web\n\nStrings for the web app.\n');
  }

  it('sends the same requests and writes the same files for a full translate run', async () => {
    writeBaseFiles();

    await runTranslate({});

    expect(calls).toMatchSnapshot('requests');
    expect({
      'locales/sv/common.yml': readFileSync('locales/sv/common.yml', 'utf-8'),
      'web/sv/app.json': readFileSync('web/sv/app.json', 'utf-8')
    }).toMatchSnapshot('files');
  });

  it('sends the same requests for a changed-only run on a pull request branch', async () => {
    execSync('git init -q -b main', { stdio: 'pipe' });
    writeBaseFiles();
    write('legacy/en/legacy.yml', 'en:\n  old_title: Old title\n');
    write('legacy/sv/legacy.yml', 'sv:\n  old_title: Gammal titel\n');
    write('locales/en/gone.md', '# Gone\n\nRemoved on the branch.\n');
    git('add .');
    git('commit -qm base');

    git('checkout -q -b feature/more-keys');
    write('locales/en/common.yml', 'en:\n  greeting: Hello\n  farewell: Goodbye\n  nested:\n    title: Settings\n  added: Added on the branch\n');
    write('locales/sv/common.yml', 'sv:\n  greeting: Hej\n  farewell: Hej då\n');
    write('locales/en/README.md', '# Notes\n\nThis folder holds the English strings, now edited.\n');
    write('locales/en/notes.md', '# More notes\n\nAdded on the branch.\n');
    rmSync('legacy/en/legacy.yml');
    rmSync('legacy/sv/legacy.yml');
    rmSync('locales/en/gone.md');
    git('add -A');
    git('commit -qm "branch changes"');

    await runTranslate({ changedOnly: true });

    expect(calls).toMatchSnapshot('requests');
    expect(readFileSync('locales/sv/common.yml', 'utf-8')).toMatchSnapshot('files');
  });

  it('sends the same alignment request for reworded and added source texts', async () => {
    execSync('git init -q -b main', { stdio: 'pipe' });
    writeBaseFiles();
    write('locales/sv/common.yml', 'sv:\n  greeting: Hej\n  farewell: Hej då\n  nested:\n    title: Inställningar\n');
    write('web/sv/app.json', '{\n  "save": "Spara",\n  "cancel": "Avbryt"\n}\n');
    git('add .');
    git('commit -qm base');

    git('checkout -q -b feature/reword');
    write('locales/en/common.yml', 'en:\n  greeting: Hello there\n  farewell: Goodbye\n  nested:\n    title: Preferences\n  added: Added with its translation\n');
    write('locales/sv/common.yml', 'sv:\n  greeting: Hej\n  farewell: Hej då\n  nested:\n    title: Inställningar\n  added: Tillagd med sin översättning\n');
    write('locales/en/README.md', '# Notes\n\nReworded on the branch.\n');
    git('add -A');
    git('commit -qm "reword source texts"');

    await runTranslate({ changedOnly: true });

    expect(calls.filter(call => call.path.endsWith('/source_alignments'))).toHaveLength(1);
    expect(calls).toMatchSnapshot('requests');
    expect(readFileSync('locales/sv/common.yml', 'utf-8')).toMatchSnapshot('files');
  });
});
