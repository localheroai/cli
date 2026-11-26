import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ci } from '../../src/commands/ci.js';
import { installFakeApi, useTestEnvironment, jsonResponse, type FakeApi } from '../helpers/fake-api.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');

const config = {
  schemaVersion: '1.0',
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md}' },
  lastSyncedAt: null
};

const EDITED = '---\ntitle: "Exportera en rapport"\n---\n\n# Exportera en rapport\n\nRedigerad på Localhero 🎉\n';

function cell(filePath: string, value: unknown, key = path.basename(filePath)) {
  return {
    path: filePath,
    language: 'sv',
    translations: [{ key, name: key, context: null, value, old_values: [], file_references: null, updated_at: '2026-11-26T10:00:00Z' }]
  };
}

const categoryCell = {
  path: 'categories/sv/topics.yml',
  language: 'sv',
  translations: [{ key: 'topics.billing', name: 'topics.billing', value: 'Fakturor', updated_at: '2026-11-26T10:00:00Z' }]
};

describe('ci sync with articles', () => {
  let directory: string;
  let originalCwd: string;
  let restoreEnvironment: () => void;
  let api: FakeApi;
  let exit: jest.SpiedFunction<typeof process.exit>;
  let autoCommitSyncChanges: jest.Mock<any>;

  function servePages(pages: unknown[][]): void {
    api.restore();
    api = installFakeApi((call) => {
      const url = new URL(`https://api.test${call.path}`);
      if (call.method !== 'GET' || !url.pathname.includes('/translation_syncs/')) return undefined;
      const page = Number(url.searchParams.get('page'));
      return jsonResponse({
        sync: { sync_id: 'sync_1', status: 'ready', created_at: '2026-11-26T10:00:00Z', files: pages[page - 1] },
        pagination: { current_page: page, total_pages: pages.length, total_count: pages.flat().length }
      });
    });
  }

  async function runSync(inGitHubActions = false): Promise<string> {
    const lines: string[] = [];
    const record = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    await ci({}, {
      console: { log: record, error: record },
      configUtils: {
        getProjectConfig: async () => structuredClone(config),
        getValidProjectConfig: async () => structuredClone(config),
        saveProjectConfig: async () => undefined
      },
      authUtils: { checkAuth: async () => true },
      githubUtils: { isGitHubAction: () => inGitHubActions, autoCommitSyncChanges },
      env: { LOCALHERO_SYNC_ID: 'sync_1', LOCALHERO_SYNC_VERSION: '2' },
      translateCommand: jest.fn(),
      syncApi: await import('../../src/api/sync.js'),
      updateTranslationFile: (await import('../../src/utils/translation-updater/index.js')).updateTranslationFile
    } as any);
    return lines.join('\n');
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sync-documents-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    restoreEnvironment = useTestEnvironment();
    api = installFakeApi();
    autoCommitSyncChanges = jest.fn<any>(async () => 'new');
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    api.restore();
    restoreEnvironment();
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  });

  it('tells the server on every page that it can sync articles', async () => {
    servePages([[categoryCell], [cell('articles/sv/export-reports.md', EDITED)]]);

    await runSync();

    const pages = api.callsTo('/translation_syncs/sync_1', 'GET').map(call => new URL(`https://api.test${call.path}`).searchParams);
    expect(pages.map(query => query.get('page'))).toEqual(['1', '2']);
    expect(pages.map(query => query.getAll('capabilities[]'))).toEqual([['documents'], ['documents']]);
    expect(pages.map(query => query.get('version'))).toEqual(['2', '2']);
  });

  it('rewrites the edited article whole and leaves the others alone', async () => {
    const untouched = readFileSync('articles/en/export-reports.md', 'utf-8');
    servePages([[categoryCell, cell('articles/sv/export-reports.md', EDITED)]]);

    await runSync();

    expect(readFileSync('articles/sv/export-reports.md', 'utf-8')).toBe(EDITED);
    expect(readFileSync('articles/en/export-reports.md', 'utf-8')).toBe(untouched);
    expect(readFileSync('categories/sv/topics.yml', 'utf-8')).toContain('billing: Fakturor');
    expect(existsSync('articles/sv/en.md')).toBe(false);
    expect(api.callsTo('/complete_update')).toHaveLength(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('gives a new article the line endings of its English source', async () => {
    writeFileSync('articles/en/sub/nested-guide.md', '# Nested guide\r\n\r\nA guide kept one folder down.\r\n');
    servePages([[cell('articles/sv/sub/nested-guide.md', '# Nästlad guide\n\nEn guide en mapp ner.\n')]]);

    await runSync();

    expect(readFileSync('articles/sv/sub/nested-guide.md', 'utf-8')).toBe('# Nästlad guide\r\n\r\nEn guide en mapp ner.\r\n');
  });

  it.each([
    ['two translations', { ...cell('articles/sv/export-reports.md', EDITED), translations: [
      { key: 'export-reports.md', value: EDITED }, { key: 'title', value: 'Rubrik' }
    ] }],
    ['no translation', { ...cell('articles/sv/export-reports.md', EDITED), translations: [] }],
    ['a key that is not the file name', cell('articles/sv/export-reports.md', EDITED, 'title')],
    ['an object value', cell('articles/sv/export-reports.md', { title: 'Rubrik' })],
    ['a list value', cell('articles/sv/export-reports.md', ['Rubrik'])]
  ])('fails on an article cell with %s before writing any file', async (_name, broken) => {
    const article = readFileSync('articles/sv/export-reports.md', 'utf-8');
    const categories = readFileSync('categories/sv/topics.yml', 'utf-8');
    servePages([[categoryCell], [broken]]);

    const output = await runSync();

    expect(exit).toHaveBeenCalledWith(1);
    expect(output).toContain('articles/sv/export-reports.md');
    expect(readFileSync('articles/sv/export-reports.md', 'utf-8')).toBe(article);
    expect(readFileSync('categories/sv/topics.yml', 'utf-8')).toBe(categories);
    expect(api.callsTo('/complete_update')).toHaveLength(0);
  });

  it('writes nothing for an article without a value and keeps it out of the commit', async () => {
    servePages([[categoryCell, cell('articles/sv/notes-en.md', null), cell('articles/sv/export-reports.md', EDITED)]]);

    await runSync(true);

    expect(existsSync('articles/sv/notes-en.md')).toBe(false);
    expect(autoCommitSyncChanges.mock.calls[0][0]).toEqual(['categories/sv/topics.yml', 'articles/sv/export-reports.md']);
    expect(exit).not.toHaveBeenCalled();
  });
});
