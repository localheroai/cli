import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { ci } from '../../src/commands/ci.js';
import { configService } from '../../src/utils/config.js';
import { githubService } from '../../src/utils/github.js';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

const EDITOR = 'newsroom-editor';
const PORTAL = 'newsroom-portal';

function writeApp(repo: string, app: string, config: object, localeDir: string): void {
  const dir = path.join(repo, 'apps', app);
  mkdirSync(path.join(dir, localeDir), { recursive: true });
  writeFileSync(path.join(dir, 'localhero.json'), JSON.stringify(config, null, 2));
  writeFileSync(path.join(dir, localeDir, 'en.json'), JSON.stringify({ headline: 'News' }, null, 2));
  writeFileSync(path.join(dir, localeDir, 'sv.json'), JSON.stringify({ headline: 'Gamla nyheter' }, null, 2));
}

function appConfig(projectId: string, localeDir: string, outputLocales = ['sv']) {
  return { projectId, sourceLocale: 'en', outputLocales, translationFiles: { paths: [`${localeDir}/`] } };
}

// Stands in for the server: it owns the matching decision, given the caller's projectId.
function editorSyncApi() {
  return {
    getSyncTranslations: jest.fn(async (_syncId: string, options: { projectId?: string } = {}) => ({
      sync: {
        sync_id: 'sync_editor',
        project_id: EDITOR,
        project_matches: options.projectId === EDITOR,
        status: 'completed',
        created_at: '2026-10-08T00:00:00Z',
        files: [{
          path: 'public/locale/sv.json',
          language: 'sv',
          translations: [{ key: 'headline', name: 'headline', value: 'Nyheter', updated_at: '2026-10-08T00:00:00Z' }]
        }]
      },
      pagination: { current_page: 1, total_pages: 1, total_count: 1, next_page: null, prev_page: null, items_per_page: 500 }
    })),
    completeSyncUpdate: jest.fn(async () => ({ success: true, status: 'completed' }))
  };
}

describe('ci sync mode in a monorepo with one project per app', () => {
  let repo: string;
  let originalCwd: string;
  let exit: jest.SpiedFunction<typeof process.exit>;

  const read = (relative: string) => readFileSync(path.join(repo, relative), 'utf8');

  async function runCiIn(app: string, syncApi: ReturnType<typeof editorSyncApi>) {
    process.chdir(path.join(repo, 'apps', app));
    await ci({}, {
      console: { log: jest.fn(), error: jest.fn() },
      configUtils: configService,
      authUtils: { checkAuth: async () => true },
      githubUtils: { ...githubService, isGitHubAction: () => false },
      env: { LOCALHERO_SYNC_ID: 'sync_editor', LOCALHERO_SYNC_VERSION: '2' },
      translateCommand: jest.fn(async () => undefined),
      syncApi,
      updateTranslationFile
    });
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(path.join(os.tmpdir(), 'ci-monorepo-'));
    writeApp(repo, 'editor', appConfig(EDITOR, 'public/locale'), 'public/locale');
    writeApp(repo, 'portal', appConfig(PORTAL, 'public/locales'), 'public/locales');
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    exit.mockRestore();
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('the owning app applies the sync to its own files', async () => {
    const syncApi = editorSyncApi();

    await runCiIn('editor', syncApi);

    expect(JSON.parse(read('apps/editor/public/locale/sv.json')).headline).toBe('Nyheter');
    expect(syncApi.completeSyncUpdate).toHaveBeenCalledWith('sync_editor', 2);
    expect(read('apps/portal/public/locales/sv.json')).toContain('Gamla nyheter');
  });

  it('a sibling app leaves every file alone and does not complete the sync', async () => {
    const syncApi = editorSyncApi();
    const editorBefore = read('apps/editor/public/locale/sv.json');
    const portalConfigBefore = read('apps/portal/localhero.json');

    await runCiIn('portal', syncApi);

    expect(read('apps/portal/public/locales/sv.json')).toContain('Gamla nyheter');
    expect(existsSync(path.join(repo, 'apps/portal/public/locale'))).toBe(false);
    expect(read('apps/editor/public/locale/sv.json')).toBe(editorBefore);
    expect(read('apps/portal/localhero.json')).toBe(portalConfigBefore);
    expect(syncApi.completeSyncUpdate).not.toHaveBeenCalled();
  });

  it('a sibling app with a config that would fail validation still stands down cleanly', async () => {
    writeFileSync(
      path.join(repo, 'apps/portal/localhero.json'),
      JSON.stringify(appConfig(PORTAL, 'public/locales', []), null, 2)
    );

    await expect(runCiIn('portal', editorSyncApi())).resolves.toBeUndefined();
  });
});
