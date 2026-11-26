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
  translatedText,
  type FakeApi,
  type RecordedCall
} from '../helpers/fake-api.js';
import { translateRunner } from '../helpers/translate-runner.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');

const config = {
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md}' }
};

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

function isDocumentImport(call: RecordedCall): boolean {
  return call.body.files.some((file: any) => file.path.endsWith('.md'));
}

describe('translate --changed-only with articles', () => {
  let directory: string;
  let originalCwd: string;
  let restoreEnvironment: () => void;
  let api: FakeApi;

  const articleJobs = () => api.callsTo('/translation_jobs').map(call => call.body.files[0].path).filter(file => file.endsWith('.md'));
  const finalizeCalls = () => api.callsTo('/translation_jobs/finalize');
  const importCalls = () => api.callsTo('/pull_request_imports');

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'documents-changed-only-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    execSync('git init -q -b main', { stdio: 'pipe' });
    write('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturering\n    reports: Rapporter\n');
    commitAll('base');
    git('checkout -q -b feature/new-article');

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

  it('sends only the article the branch adds and lists it in the manifest', async () => {
    write('articles/en/invite-teammates.md', '# Invite teammates\n\nOpen **Team** and press Invite.\n');
    commitAll('add an article');

    await translateRunner(config).run({ changedOnly: true });

    expect(articleJobs()).toEqual(['articles/en/invite-teammates.md']);
    expect(readFileSync('articles/sv/invite-teammates.md', 'utf-8')).toBe(
      translatedText('# Invite teammates\n\nOpen **Team** and press Invite.\n', 'sv')
    );
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0].body).toMatchObject({
      branch: 'feature/new-article',
      pr_key_manifest: { 'articles/en/invite-teammates.md': [{ name: 'invite-teammates.md' }] },
      removed_key_manifest: {}
    });
  });

  it('lists a deleted English article in the removed manifest, also one whose slug is a locale code', async () => {
    git('checkout -q main');
    write('articles/en/sv.md', '# Swedish\n\nAbout the Swedish edition.\n');
    commitAll('an article named like a locale');
    git('checkout -q feature/new-article');
    git('merge -q main');
    rmSync('articles/en/sv.md');
    rmSync('articles/en/notes-en.md');
    rmSync('articles/sv/export-reports.md');
    commitAll('remove articles');

    await translateRunner(config).run({ changedOnly: true });

    expect(finalizeCalls()[0].body.removed_key_manifest).toEqual({
      'articles/en/sv.md': [{ name: 'sv.md' }],
      'articles/en/notes-en.md': [{ name: 'notes-en.md' }]
    });
  });

  it('never lists a deleted MDX article', async () => {
    const withMdx = { ...config, translationFiles: { ...config.translationFiles, pattern: '**/*.{yml,md,mdx}' } };
    git('checkout -q main');
    write('articles/en/widget.mdx', '# Widget\n');
    commitAll('an MDX article');
    git('checkout -q feature/new-article');
    git('merge -q main');
    rmSync('articles/en/widget.mdx');
    commitAll('remove it');

    await translateRunner(withMdx).run({ changedOnly: true });

    expect(JSON.stringify(api.calls)).not.toContain('widget.mdx');
  });

  it('keeps an article in the manifest when ignoreKeys matches its file name', async () => {
    write('articles/en/invite-teammates.md', '# Invite teammates\n');
    write('articles/en/export-reports.md', '# Export a report\n\nReworded.\n');
    commitAll('add an article, reword another');
    const ignoring = { ...config, translationFiles: { ...config.translationFiles, ignoreKeys: ['invite-teammates.*', 'export-reports.md'] } };

    await translateRunner(ignoring).run({ changedOnly: true });

    expect(articleJobs()).toEqual(['articles/en/invite-teammates.md']);
    expect(finalizeCalls()[0].body.pr_key_manifest).toEqual({
      'articles/en/invite-teammates.md': [{ name: 'invite-teammates.md' }],
      'articles/en/export-reports.md': [{ name: 'export-reports.md' }]
    });
    expect(importCalls()[0].body.files.map((file: any) => file.path)).toEqual(['articles/en/export-reports.md']);
  });

  it('sends a committed translation in a request of its own, as the contract describes', async () => {
    write('articles/en/invite-teammates.md', '# Invite teammates\n\nOpen **Team**.\n');
    write('articles/sv/invite-teammates.md', '# Bjud in kollegor\r\n\r\nÖppna **Team**.\r\n');
    write('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturor\n    reports: Rapporter\n');
    commitAll('article with its translation, and a reworded key');

    await translateRunner(config).run({ changedOnly: true });

    expect(articleJobs()).toEqual([]);
    expect(JSON.stringify(api.calls.filter(call => /alignments/.test(call.path)))).not.toContain('.md');
    expect(importCalls()).toHaveLength(2);
    const [keyImport, documentImport] = importCalls();
    expect(keyImport.body.files.map((file: any) => file.path)).toEqual(['categories/sv/topics.yml']);
    expect(documentImport.body).toEqual({
      branch: 'feature/new-article',
      job_group_id: keyImport.body.job_group_id,
      files: [{
        path: 'articles/sv/invite-teammates.md',
        source_path: 'articles/en/invite-teammates.md',
        locale: 'sv',
        format: 'markdown',
        changes: [{ key: 'invite-teammates.md', status: 'added', value: '# Bjud in kollegor\n\nÖppna **Team**.\n' }]
      }]
    });
  });

  it('sends an edited English article as an update without a source value, and says its translations wait', async () => {
    const before = readFileSync('articles/en/export-reports.md', 'utf-8');
    const after = before.replace('Open **Reports**', 'Go to **Reports**');
    write('articles/en/export-reports.md', after);
    commitAll('reword an existing article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(articleJobs()).toEqual([]);
    expect(importCalls()).toHaveLength(1);
    expect(importCalls()[0].body.files).toEqual([{
      path: 'articles/en/export-reports.md',
      source_path: 'articles/en/export-reports.md',
      locale: 'en',
      format: 'markdown',
      changes: [{ key: 'export-reports.md', status: 'updated', value: after, old_value: before }]
    }]);
    expect(runner.output()).toContain('1 source article changed. Its translations were kept and are not updated yet.');
    expect(runner.output()).not.toContain('align them from the Localhero comment');
    expect(api.calls.filter(call => /alignments/.test(call.path))).toEqual([]);
  });

  it('sends article files ten to a request', async () => {
    for (let i = 1; i <= 12; i++) {
      write(`articles/en/guide-${i}.md`, `# Guide ${i}\n`);
      write(`articles/sv/guide-${i}.md`, `# Guide ${i} på svenska\n`);
    }
    commitAll('twelve translated articles');

    await translateRunner(config).run({ changedOnly: true });

    const sizes = importCalls().map(call => call.body.files.length);
    expect(sizes).toEqual([10, 2]);
    expect(importCalls().every(isDocumentImport)).toBe(true);
    const sent = importCalls().flatMap(call => call.body.files.map((file: any) => file.path));
    expect(new Set(sent).size).toBe(12);
  });

  it('warns with the code when the server refuses an article import, and still sends the key files', async () => {
    api.restore();
    api = installFakeApi((call) => call.path.endsWith('/pull_request_imports') && isDocumentImport(call)
      ? errorResponse(422, 'document_file', 'Articles are not enabled for this project')
      : undefined);
    for (let i = 1; i <= 12; i++) {
      write(`articles/en/guide-${i}.md`, `# Guide ${i}\n`);
      write(`articles/sv/guide-${i}.md`, `# Guide ${i} på svenska\n`);
    }
    write('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturor\n    reports: Rapporter\n');
    commitAll('translated articles and a reworded key');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(importCalls().filter(call => !isDocumentImport(call))).toHaveLength(1);
    expect(importCalls().filter(isDocumentImport)).toHaveLength(1);
    expect(runner.output()).toContain('Sent 1 translation value from this PR for review');
    expect(runner.output()).toContain(
      'Could not send 12 article files for review: Articles are not enabled for this project (document_file)'
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('finalizes once more without articles when they are switched off, and says so', async () => {
    api.restore();
    api = installFakeApi((call) => {
      const manifests = JSON.stringify([call.body?.pr_key_manifest, call.body?.removed_key_manifest]);
      return call.path.endsWith('/finalize') && manifests.includes('.md')
        ? errorResponse(422, 'document_file', 'Articles are not enabled for this project')
        : undefined;
    });
    write('articles/en/invite-teammates.md', '# Invite teammates\n');
    write('articles/sv/invite-teammates.md', '# Bjud in kollegor\n');
    write('categories/en/topics.yml', 'en:\n  topics:\n    billing: Billing\n    reports: Reports\n    teams: Teams\n');
    rmSync('articles/en/notes-en.md');
    commitAll('an article, a new key, a removed article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(finalizeCalls()).toHaveLength(2);
    expect(Object.keys(finalizeCalls()[0].body.pr_key_manifest).sort()).toEqual([
      'articles/en/invite-teammates.md',
      'categories/en/topics.yml'
    ]);
    expect(finalizeCalls()[1].body).toEqual({
      ...finalizeCalls()[0].body,
      pr_key_manifest: { 'categories/en/topics.yml': [{ name: 'topics.teams' }] },
      removed_key_manifest: {}
    });
    expect(runner.output()).toContain('Articles are not enabled for this project');
  });

  it('translates a new article again when its English changed after the translation was committed', async () => {
    write('articles/en/invite-teammates.md', '# Invite teammates\n\nOpen **Team**.\n');
    commitAll('add an article');
    write('articles/sv/invite-teammates.md', '# (sv) Invite teammates\n\nOpen **Team**.\n');
    commitAll('Update translations');
    const reworded = '# Invite teammates\n\nOpen **Team** and press Invite.\n';
    write('articles/en/invite-teammates.md', reworded);
    commitAll('reword the new article');
    const runner = translateRunner(config);

    await runner.run({ changedOnly: true });

    expect(articleJobs()).toEqual(['articles/en/invite-teammates.md']);
    expect(readFileSync('articles/sv/invite-teammates.md', 'utf-8')).toBe(translatedText(reworded, 'sv'));
    expect(runner.autoCommitChanges.mock.calls[0][1]).toMatchObject({ articlesTranslated: 1, articleLanguages: ['sv'] });
    expect(JSON.stringify(importCalls())).not.toContain('articles/sv/invite-teammates.md');
  });

  it('still sends the committed translation for review when translating the article again fails', async () => {
    api.restore();
    api = installFakeApi((_call, job) => job
      ? jsonResponse({ status: 'failed', language: { code: 'sv' }, error_details: 'structure check failed' })
      : undefined);
    write('articles/en/invite-teammates.md', '# Invite teammates\n\nOpen **Team**.\n');
    commitAll('add an article');
    write('articles/sv/invite-teammates.md', '# Bjud in kollegor\n');
    commitAll('Update translations');
    write('articles/en/invite-teammates.md', '# Invite teammates\n\nOpen **Team** and press Invite.\n');
    commitAll('reword the new article');

    await translateRunner(config).run({ changedOnly: true });

    expect(importCalls().flatMap(call => call.body.files.map((file: any) => file.path))).toEqual(['articles/sv/invite-teammates.md']);
    expect(process.exitCode).toBe(1);
  });
});
