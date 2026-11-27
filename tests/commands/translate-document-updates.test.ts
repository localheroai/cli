import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  installFakeApi,
  useTestEnvironment,
  errorResponse,
  jsonResponse,
  type FakeApi,
  type RecordedCall
} from '../helpers/fake-api.js';
import { translateRunner } from '../helpers/translate-runner.js';

// Each test builds a real git repository; on a busy machine that outlasts the default five seconds.
jest.setTimeout(30000);

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');

const config = {
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md}' }
};

const ENGLISH = 'articles/en/export-reports.md';
const SWEDISH = 'articles/sv/export-reports.md';
const UPDATED = '---\ntitle: "Exportera en rapport"\n---\n\n# Exportera en rapport\n\nGå till **Rapporter** 🎉\n';

function git(command: string): void {
  execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${command}`, { stdio: 'pipe' });
}

function commitAll(message: string): void {
  git('add -A');
  git(`commit -qm "${message}"`);
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function isAlignment(call: RecordedCall): boolean {
  return call.path.endsWith('/source_alignments');
}

function isArticleAlignment(call: RecordedCall): boolean {
  return isAlignment(call) && call.body.items.some((item: any) => item.key.endsWith('.md'));
}

function answer(call: RecordedCall, fields: Record<string, unknown>): Response {
  const [item] = call.body.items;
  return jsonResponse({
    enabled: true,
    notices: [],
    job_group: { id: 'group', short_url: 'https://localhero.ai/r/abc' },
    items: [{ source_path: item.source_path, target_path: item.target_path, key: item.key, ...fields }]
  });
}

describe('translate --changed-only with an edited article', () => {
  let directory: string;
  let originalCwd: string;
  let restoreEnvironment: () => void;
  let api: FakeApi;
  let englishBefore: string;
  let englishAfter: string;
  let swedishBefore: string;

  const articleAlignments = () => api.calls.filter(isArticleAlignment);
  const importCalls = () => api.callsTo('/pull_request_imports');
  const serve = (respond: (call: RecordedCall) => Response | undefined): void => {
    api.restore();
    api = installFakeApi((call) => (call.method === 'POST' ? respond(call) : undefined));
  };
  const rewordEnglish = (file = ENGLISH): void => {
    write(file, readFileSync(file, 'utf-8').replace(/^# (.*)$/m, '# $1, reworded'));
  };

  beforeEach(() => {

    process.exitCode = undefined;
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'document-updates-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    execSync('git init -q -b main && git config core.autocrlf false', { stdio: 'pipe' });
    write('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturering\n    reports: Rapporter\n');
    write('articles/sv/en.md', '# Språkkoder\n\nKoden `en` står för engelska.\n');
    commitAll('base');
    git('checkout -q -b feature/reword-article');

    englishBefore = readFileSync(ENGLISH, 'utf-8');
    swedishBefore = readFileSync(SWEDISH, 'utf-8');
    rewordEnglish();
    englishAfter = readFileSync(ENGLISH, 'utf-8');
    commitAll('reword an article');

    restoreEnvironment = useTestEnvironment();
    api = installFakeApi();
    serve(call => (isArticleAlignment(call) ? answer(call, { status: 'aligned', value: UPDATED, anchor_digest: 'a1b2c3' }) : undefined));
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

  it('sends the article as one alignment item, as the contract describes', async () => {
    await translateRunner(config).run({ changedOnly: true });

    expect(articleAlignments()).toHaveLength(1);
    expect(articleAlignments()[0].body).toEqual({
      branch: 'feature/reword-article',
      head_sha: expect.any(String),
      job_group_id: expect.any(String),
      locale: 'sv',
      items: [{
        source_path: ENGLISH,
        target_path: SWEDISH,
        format: 'markdown',
        key: 'export-reports.md',
        previous_source: englishBefore,
        source: englishAfter,
        target_base: swedishBefore,
        target_current: swedishBefore
      }]
    });
    expect(api.callsTo('/translation_jobs')).toEqual([]);
  });

  it('asks once for an article that two configured paths both hold', async () => {
    const overlapping = { ...config, translationFiles: { ...config.translationFiles, paths: ['articles/', 'articles/en/', 'articles/sv/'] } };

    await translateRunner(overlapping, 'new').run({ changedOnly: true });

    expect(articleAlignments()).toHaveLength(1);
    const aligned = importCalls().filter(call => JSON.stringify(call.body).includes('aligned_source'));
    expect(aligned.flatMap(call => call.body.files).map(file => file.changes.length)).toEqual([1]);
  });

  it('writes the updated article whole and commits it', async () => {
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(UPDATED);
    expect(runner.autoCommitChanges).toHaveBeenCalledTimes(1);
    expect(runner.autoCommitChanges.mock.calls[0][1]).toMatchObject({
      keysTranslated: 0,
      keysAligned: 0,
      articlesUpdated: 1,
      articleUpdateLanguages: ['sv'],
      viewUrl: 'https://localhero.ai/r/abc'
    });
    expect(runner.output()).toContain('» Article updates:');
    expect(runner.output()).toContain('  sv: export-reports.md updated');
    expect(runner.output()).not.toContain('not updated yet');
    expect(process.exitCode).toBeUndefined();
  });

  it('sends the committed update for review with the English it was made from and the digest', async () => {
    await translateRunner(config, 'new').run({ changedOnly: true });

    const aligned = importCalls().filter(call => JSON.stringify(call.body).includes('aligned_source'));
    expect(aligned).toHaveLength(1);
    expect(aligned[0].body.files).toEqual([{
      path: SWEDISH,
      source_path: ENGLISH,
      locale: 'sv',
      format: 'markdown',
      changes: [{
        key: 'export-reports.md',
        status: 'updated',
        value: UPDATED,
        old_value: swedishBefore,
        aligned_source: englishAfter,
        aligned_from_digest: 'a1b2c3'
      }]
    }]);
  });

  it('keeps articles in alignment requests of their own, after the key request', async () => {
    write('categories/en/topics.yml', 'en:\n  topics:\n    billing: Invoices\n    reports: Reports\n');
    rewordEnglish('articles/en/en.md');
    commitAll('reword a key and a second article');

    await translateRunner(config).run({ changedOnly: true });

    const alignments = api.calls.filter(isAlignment).map(call => call.body.items.map((item: any) => item.key));
    expect(alignments[0]).toEqual(['topics.billing']);
    expect(alignments.slice(1).sort()).toEqual([['en.md'], ['export-reports.md']]);
  });

  it('updates articles when the project has copy alignment switched off', async () => {
    serve((call) => {
      if (isArticleAlignment(call)) return answer(call, { status: 'aligned', value: UPDATED, anchor_digest: 'a1b2c3' });
      return isAlignment(call) ? jsonResponse({ enabled: false, items: [], notices: [] }) : undefined;
    });
    write('categories/en/topics.yml', 'en:\n  topics:\n    billing: Invoices\n    reports: Reports\n');
    commitAll('reword a key');

    await translateRunner(config).run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(UPDATED);
    expect(readFileSync('categories/sv/topics.yml', 'utf-8')).toContain('billing: Fakturering');
  });

  it.each([
    [{ status: 'aligned', value: UPDATED, anchor_digest: 'a1', hand_updates: 1 }, 'sv: export-reports.md updated, 1 paragraph needs a hand update (edited by a reviewer)'],
    [{ status: 'aligned', value: UPDATED, anchor_digest: 'a1', hand_updates: 3 }, 'sv: export-reports.md updated, 3 paragraphs need a hand update (edited by a reviewer)'],
    [{ status: 'unchanged', hand_updates: 1 }, 'sv: export-reports.md not updated, 1 paragraph needs a hand update (edited by a reviewer)'],
    [{ status: 'unchanged', hand_updates: 2 }, 'sv: export-reports.md not updated, 2 paragraphs need a hand update (edited by a reviewer)'],
    [{ status: 'skipped', reason: 'edited_in_pr' }, 'sv: export-reports.md not updated: its translation was edited in this pull request'],
    [{ status: 'skipped', reason: 'translation_unpaired' }, 'sv: export-reports.md not updated: its translation does not follow the source paragraph by paragraph'],
    [{ status: 'skipped', reason: 'translation_out_of_sync' }, 'sv: export-reports.md not updated: its translation was made from an older source text'],
    [{ status: 'skipped', reason: 'translation_changed_on_mainline' }, 'sv: export-reports.md not updated: its translation changed on the base branch'],
    [{ status: 'skipped', reason: 'too_many_changes' }, 'sv: export-reports.md not updated: more than half of the article was rewritten'],
    [{ status: 'skipped', reason: 'too_large' }, 'sv: export-reports.md not updated: the article is too large'],
    [{ status: 'skipped', reason: 'validation_failed' }, 'sv: export-reports.md not updated: the updated text did not pass the checks'],
    [{ status: 'skipped', reason: 'not_mainline' }, 'sv: export-reports.md not updated: the article is new in a pull request that has not merged'],
    [{ status: 'skipped', reason: 'some_new_reason' }, 'sv: export-reports.md not updated: some new reason']
  ])('says in words what happened for %j', async (fields, line) => {
    serve(call => (isArticleAlignment(call) ? answer(call, fields) : undefined));
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(runner.output()).toContain(`  ${line}`);
    expect(runner.output()).not.toMatch(/already fits?|already up to date/);
  });

  it('writes nothing and commits nothing for an article that is unchanged or skipped', async () => {
    serve(call => (isArticleAlignment(call) ? answer(call, { status: 'skipped', reason: 'too_many_changes' }) : undefined));
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(swedishBefore);
    expect(runner.autoCommitChanges).not.toHaveBeenCalled();
  });

  it('says nothing about an article that is unchanged with nothing left to do', async () => {
    serve(call => (isArticleAlignment(call) ? answer(call, { status: 'unchanged' }) : undefined));
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(runner.output()).not.toContain('Article updates');
    expect(runner.output()).not.toContain('export-reports.md');
  });

  it('stops asking and keeps the translations when articles are switched off for the project', async () => {
    serve(call => (isArticleAlignment(call) ? errorResponse(422, 'document_file', 'Articles are not enabled for this project') : undefined));
    rewordEnglish('articles/en/en.md');
    commitAll('reword a second article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(articleAlignments().length).toBeLessThanOrEqual(2);
    expect(readFileSync(SWEDISH, 'utf-8')).toBe(swedishBefore);
    expect(runner.output()).toContain('Articles are switched off for this project; they were not updated.');
    expect(runner.output()).not.toContain('Articles are not enabled for this project');
    expect(runner.output()).toContain('2 source articles changed. Their translations were kept and are not updated yet.');
    expect(process.exitCode).toBeUndefined();
  });

  it('says in words that Localhero could not be reached', async () => {
    api.restore();
    const realFetch = global.fetch;
    api = installFakeApi();
    const fake = global.fetch;
    global.fetch = (async (input: any, init: any) => {
      if (String(input).endsWith('/source_alignments')) throw new TypeError('fetch failed');
      return fake(input, init);
    }) as any;
    const runner = translateRunner(config);

    try {
      await runner.run({ changedOnly: true });
    } finally {
      global.fetch = realFetch;
    }

    expect(runner.output()).toContain("  sv: export-reports.md not updated: couldn't reach Localhero");
    expect(runner.output()).not.toContain('fetch failed');
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['a refused request', (call: RecordedCall) => errorResponse(402, 'insufficient_credits', 'Insufficient credits')],
    ['a skipped article', (call: RecordedCall) => answer(call, { status: 'skipped', reason: 'insufficient_credits' })]
  ])('warns once in the pull request checks when credits ran out, for %s', async (_name, respond) => {
    process.env.GITHUB_ACTIONS = 'true';
    serve(call => (isArticleAlignment(call) ? respond(call) : undefined));
    rewordEnglish('articles/en/en.md');
    commitAll('reword a second article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    const output = runner.output();
    expect(output).toContain('  sv: en.md not updated: out of Localhero credits');
    expect(output).toContain('  sv: export-reports.md not updated: out of Localhero credits');
    expect(output.split('\n').filter(line => line.startsWith('::warning::'))).toEqual([
      '::warning::Out of Localhero credits: 2 articles were not updated'
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('counts two articles with the same file name in different folders as two', async () => {
    git('checkout -q main');
    write('articles/en/billing/index.md', '# Billing\n');
    write('articles/sv/billing/index.md', '# Fakturering\n');
    write('articles/en/reports/index.md', '# Reports\n');
    write('articles/sv/reports/index.md', '# Rapporter\n');
    commitAll('two articles named index');
    git('checkout -q feature/reword-article');
    git('merge -q main');
    git('checkout -q main -- articles/en/export-reports.md');
    rewordEnglish('articles/en/billing/index.md');
    rewordEnglish('articles/en/reports/index.md');
    commitAll('reword both');
    serve(call => (isArticleAlignment(call) ? errorResponse(402, 'insufficient_credits', 'Insufficient credits') : undefined));
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(runner.output()).toContain('Out of Localhero credits: 2 articles were not updated');
  });

  it('warns about credits in plain words outside GitHub Actions', async () => {
    serve(call => (isArticleAlignment(call) ? errorResponse(402, 'insufficient_credits', 'Insufficient credits') : undefined));
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(runner.output()).toContain('Out of Localhero credits: 1 article was not updated');
    expect(runner.output()).not.toContain('::warning::');
  });

  it('goes on with the next article when one request fails', async () => {
    serve((call) => {
      if (!isArticleAlignment(call)) return undefined;
      return call.body.items[0].key === 'en.md'
        ? errorResponse(500, 'server_error', 'Something broke')
        : answer(call, { status: 'aligned', value: UPDATED, anchor_digest: 'a1b2c3' });
    });
    rewordEnglish('articles/en/en.md');
    commitAll('reword a second article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(UPDATED);
    expect(runner.output()).toContain('  sv: en.md not updated: Something broke');
  });

  it('leaves a new article and an article without a translation to the translation jobs', async () => {
    write('articles/en/invite-teammates.md', '# Invite teammates\n');
    rewordEnglish('articles/en/notes-en.md');
    commitAll('a new article and a reworded one without a translation');

    await translateRunner(config).run({ changedOnly: true });

    expect(articleAlignments().map(call => call.body.items[0].key)).toEqual(['export-reports.md']);
    expect(api.callsTo('/translation_jobs').map(call => call.body.files[0].path).sort()).toEqual([
      'articles/en/invite-teammates.md',
      'articles/en/notes-en.md'
    ]);
  });

  it('asks for no update of a translation that is new in this pull request', async () => {
    rewordEnglish('articles/en/notes-en.md');
    write('articles/sv/notes-en.md', '# Anteckningar\n\nSkriven för hand i den här grenen.\n');
    commitAll('reword an article and add its translation by hand');

    await translateRunner(config).run({ changedOnly: true });

    expect(articleAlignments().map(call => call.body.items[0].key)).toEqual(['export-reports.md']);
    expect(articleAlignments().every(call => typeof call.body.items[0].target_base === 'string')).toBe(true);
  });

  it.each([
    ['no digest', { status: 'aligned', value: UPDATED }],
    ['an empty digest', { status: 'aligned', value: UPDATED, anchor_digest: '' }],
    ['no text', { status: 'aligned', anchor_digest: 'a1b2c3' }]
  ])('writes and commits nothing for an updated answer with %s', async (_name, fields) => {
    serve(call => (isArticleAlignment(call) ? answer(call, fields) : undefined));
    const runner = translateRunner(config, 'new');

    await runner.run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(swedishBefore);
    expect(runner.autoCommitChanges).not.toHaveBeenCalled();
    expect(JSON.stringify(importCalls())).not.toContain('aligned_source');
    expect(runner.output()).toContain('  sv: export-reports.md not updated: the answer from Localhero was incomplete');
  });

  it('reports an update the server no longer takes and keeps going', async () => {
    serve((call) => {
      if (isArticleAlignment(call)) return answer(call, { status: 'aligned', value: UPDATED, anchor_digest: 'a1b2c3' });
      return call.path.endsWith('/pull_request_imports') && JSON.stringify(call.body).includes('aligned_source')
        ? jsonResponse({ imported_count: 0, skipped: [{ path: SWEDISH, key: 'export-reports.md', locale: 'sv', reason: 'baseline_changed' }] })
        : undefined;
    });
    const runner = translateRunner(config, 'new');

    await runner.run({ changedOnly: true });

    expect(runner.output()).toContain('sv: export-reports.md was not taken for review: the article changed on Localhero meanwhile. The next push sends it again.');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not send the update for review when a later step changed the file', async () => {
    const runner = translateRunner({ ...config, postTranslateCommand: 'format-articles' }, 'new');
    runner.execSync.mockImplementation(() => writeFileSync(SWEDISH, `${UPDATED}\n<!-- formatted -->\n`));

    await runner.run({ changedOnly: true });

    expect(runner.execSync).toHaveBeenCalledTimes(1);
    expect(importCalls().filter(call => JSON.stringify(call.body).includes('aligned_source'))).toEqual([]);
  });

  it('sends the update for review when the file holds it with other line endings', async () => {
    write(SWEDISH, swedishBefore.replace(/\n/g, '\r\n'));
    commitAll('Windows line endings in the translation');

    await translateRunner(config, 'new').run({ changedOnly: true });

    expect(readFileSync(SWEDISH, 'utf-8')).toBe(UPDATED.replace(/\n/g, '\r\n'));
    expect(importCalls().filter(call => JSON.stringify(call.body).includes('aligned_source'))).toHaveLength(1);
  });
});
