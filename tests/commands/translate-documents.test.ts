import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  installFakeApi,
  useTestEnvironment,
  decodeContent,
  errorResponse,
  jsonResponse,
  translatedText,
  type FakeApi,
  type RecordedCall
} from '../helpers/fake-api.js';
import { translateRunner } from '../helpers/translate-runner.js';
import { MAX_DOCUMENT_CHARACTERS } from '../../src/utils/documents.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');

const config = {
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md}' }
};

const MISSING_ARTICLES = [
  'articles/en/README.md',
  'articles/en/draft-checklist.md',
  'articles/en/en.md',
  'articles/en/notes-en.md',
  'articles/en/sub/nested-guide.md'
];

function isArticleJob(call: RecordedCall): boolean {
  return call.method === 'POST' && call.path.endsWith('/translation_jobs') && call.body.files[0].path.endsWith('.md');
}

describe('translate with articles', () => {
  let directory: string;
  let originalCwd: string;
  let restoreEnvironment: () => void;
  let api: FakeApi;

  const jobRequests = () => api.callsTo('/translation_jobs');
  const articleRequests = () => jobRequests().filter(isArticleJob);

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'translate-documents-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    restoreEnvironment = useTestEnvironment();
    api = installFakeApi();
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    api.restore();
    restoreEnvironment();
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('translates the key files first, then each missing article as one whole file', async () => {
    const runner = translateRunner(config);

    await runner.run();

    const sent = jobRequests().map(call => call.body.files[0].path);
    expect(sent[0]).toBe('categories/en/topics.yml');
    expect(sent.slice(1).sort()).toEqual(MISSING_ARTICLES);

    for (const sourcePath of MISSING_ARTICLES) {
      const targetPath = sourcePath.replace('articles/en/', 'articles/sv/');
      expect(readFileSync(targetPath, 'utf-8')).toBe(translatedText(readFileSync(sourcePath, 'utf-8'), 'sv'));
    }
    expect(readFileSync('categories/sv/topics.yml', 'utf-8')).toContain('reports:');
    expect(runner.output()).toContain('Translated 5 articles in sv');
    expect(process.exitCode).toBeUndefined();
  });

  it('sends an article as the contract describes', async () => {
    const runner = translateRunner({ ...config, outputLocales: ['sv', 'de'] });

    await runner.run();

    const request = articleRequests().find(call => call.body.files[0].path === 'articles/en/export-reports.md');
    expect(request?.body).toEqual({
      target_languages: ['de'],
      files: [{
        path: 'articles/en/export-reports.md',
        format: 'markdown',
        content: expect.any(String),
        target_paths: { de: 'articles/de/export-reports.md' }
      }],
      job_group_id: expect.any(String)
    });
    expect(decodeContent(request?.body.files[0])).toEqual({
      keys: { 'export-reports.md': { value: readFileSync('articles/en/export-reports.md', 'utf-8') } }
    });

    const nested = articleRequests().find(call => call.body.files[0].path === 'articles/en/sub/nested-guide.md');
    expect(nested?.body.target_languages).toEqual(['sv', 'de']);
    expect(nested?.body.files[0].target_paths).toEqual({
      sv: 'articles/sv/sub/nested-guide.md',
      de: 'articles/de/sub/nested-guide.md'
    });
  });

  it('sends an article whose text mentions wip_', async () => {
    await translateRunner(config).run();

    expect(articleRequests().map(call => call.body.files[0].path)).toContain('articles/en/draft-checklist.md');
  });

  it('has nothing to do on a second run', async () => {
    await translateRunner(config).run();
    const requestsAfterFirstRun = jobRequests().length;

    const second = translateRunner(config);
    await second.run();

    expect(jobRequests()).toHaveLength(requestsAfterFirstRun);
    expect(second.output()).toContain('All translations are up to date');
  });

  it('commits a run that wrote only articles', async () => {
    writeFileSync('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturering\n    reports: Rapporter\n');
    const runner = translateRunner(config);

    await runner.run();

    expect(jobRequests().every(isArticleJob)).toBe(true);
    expect(runner.autoCommitChanges).toHaveBeenCalledTimes(1);
    expect(runner.autoCommitChanges.mock.calls[0][1]).toMatchObject({
      keysTranslated: 0,
      languages: [],
      articlesTranslated: 5,
      articleLanguages: ['sv']
    });
  });

  it('commits the articles that were written and fails the run when one article fails', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    api.restore();
    api = installFakeApi((_call, job) => job?.path === 'articles/en/en.md'
      ? jsonResponse({ status: 'failed', language: { code: 'sv' }, error_details: 'structure check failed' })
      : undefined);
    const runner = translateRunner(config);

    await runner.run();

    expect(existsSync('articles/sv/en.md')).toBe(false);
    expect(existsSync('articles/sv/notes-en.md')).toBe(true);
    expect(runner.autoCommitChanges.mock.calls[0][1]).toMatchObject({ articlesTranslated: 4 });
    expect(runner.output()).toContain('::error::Article not translated: articles/en/en.md (sv)');
    expect(runner.output()).toContain('structure check failed');
    expect(process.exitCode).toBe(1);
  });

  it('refuses an article over the limit itself, warns and leaves the exit code alone', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    writeFileSync('articles/en/long-read.md', `# Long read\n\n${'a'.repeat(MAX_DOCUMENT_CHARACTERS)}\n`);
    const runner = translateRunner(config);

    await runner.run();

    expect(articleRequests().map(call => call.body.files[0].path)).not.toContain('articles/en/long-read.md');
    expect(runner.output()).toMatch(/::warning::Article skipped: articles\/en\/long-read\.md, the article has \d+ characters, the limit is 20000/);
    expect(existsSync('articles/sv/notes-en.md')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps MDX articles out of every request and says so', async () => {
    writeFileSync('articles/en/widget.mdx', '# Widget\n\n<Widget />\n');
    const runner = translateRunner({
      ...config,
      translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md,mdx}' }
    });

    await runner.run();

    expect(JSON.stringify(api.calls)).not.toContain('widget.mdx');
    expect(runner.output()).toContain('Article skipped: articles/en/widget.mdx, MDX articles are not supported yet');
    expect(existsSync('articles/sv/widget.mdx')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('still translates and commits the key files when articles are switched off for the project', async () => {
    api.restore();
    api = installFakeApi((call) => isArticleJob(call)
      ? errorResponse(422, 'document_file', 'Articles are not enabled for this project')
      : undefined);
    const runner = translateRunner(config);

    await runner.run();

    expect(readFileSync('categories/sv/topics.yml', 'utf-8')).toContain('reports:');
    expect(existsSync('articles/sv/notes-en.md')).toBe(false);
    expect(runner.autoCommitChanges.mock.calls[0][1]).toMatchObject({ keysTranslated: 1, languages: ['sv'] });
    expect(runner.autoCommitChanges.mock.calls[0][1].articlesTranslated).toBeUndefined();
    expect(runner.output()).toContain('5 articles were not translated: Articles are not enabled for this project');
    expect(process.exitCode).toBe(1);
  });

  it('reports a language the server leaves for article updates without failing', async () => {
    api.restore();
    api = installFakeApi((call) => isArticleJob(call)
      ? jsonResponse({
        jobs: [],
        skipped_documents: [{ path: call.body.files[0].path, language: 'sv', reason: 'new_language_waits_for_updates' }]
      }, 201)
      : undefined);
    const runner = translateRunner(config);

    await runner.run();

    expect(runner.output()).toContain(
      'Not translated yet: articles/en/en.md (sv). New languages for existing articles come with article updates.'
    );
    expect(existsSync('articles/sv/en.md')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });
});
