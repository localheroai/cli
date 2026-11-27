import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { check, type CheckOptions } from '../../src/commands/check.js';
import { findTranslationFiles } from '../../src/utils/files.js';
import { execSync } from 'child_process';
import { runGit, type GitRunner } from '../../src/utils/check-git.js';
import { fakeGit } from '../helpers/fake-git.js';

// Each test builds a real git repository; on a busy machine that outlasts the default five seconds.
jest.setTimeout(30000);

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');
const KEY_FILES_ONLY = '**/*.yml';
const WITH_ARTICLES = '**/*.{yml,md}';

describe('check with articles', () => {
  let directory: string;
  let originalCwd: string;

  async function runCheck(
    pattern: string,
    options: CheckOptions = {},
    env: Record<string, string> = {},
    git: GitRunner = fakeGit({ isRepo: false })
  ) {
    const log = jest.fn();
    const error = jest.fn();
    await check(options, {
      console: { log, error },
      configUtils: {
        getProjectConfig: async () => ({
          projectId: 'help-center',
          sourceLocale: 'en',
          outputLocales: ['sv'],
          translationFiles: { paths: ['categories/', 'articles/'], pattern }
        })
      },
      fileUtils: { findTranslationFiles },
      projectDetection: { detectProjectType: jest.fn() },
      fsUtils: { listFiles: jest.fn(), findLocaleDirs: jest.fn(), readFile: jest.fn() },
      env,
      git,
      appendFile: jest.fn()
    } as never);
    const printed = (mock: jest.Mock) => mock.mock.calls.map(call => String(call[0]));
    return { log: printed(log), error: printed(error), exitCode: process.exitCode };
  }

  const articleNotice = (lines: string[]) => lines.filter(line => line.includes('article'));

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'check-documents-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('prints one notice and checks the key files as it does without articles', async () => {
    const without = await runCheck(KEY_FILES_ONLY);
    const withArticles = await runCheck(WITH_ARTICLES);

    expect(articleNotice(withArticles.log)).toEqual([
      expect.stringContaining('7 article files are not checked yet (articles/). Key files were checked as usual.')
    ]);
    expect(withArticles.log.filter(line => !line.includes('article'))).toEqual(without.log);
    expect(withArticles.error).toEqual(without.error);
    expect(withArticles.exitCode).toBe(1);
    expect(without.exitCode).toBe(1);
  });

  it('exits 0 when the key files are complete, whatever the articles lack', async () => {
    writeFileSync('categories/sv/topics.yml', 'sv:\n  topics:\n    billing: Fakturering\n    reports: Rapporter\n');

    const result = await runCheck(WITH_ARTICLES);

    expect(result.exitCode).toBe(0);
    expect(articleNotice(result.log)).toHaveLength(1);
  });

  it('prints the notice as a GitHub notice in the github format', async () => {
    const result = await runCheck(WITH_ARTICLES, { format: 'github' });

    expect(result.log).toContain('::notice::7 article files are not checked yet (articles/). Key files were checked as usual.');
    expect(result.exitCode).toBe(1);
  });

  it('leaves the JSON output as it is without articles', async () => {
    const without = await runCheck(KEY_FILES_ONLY, { json: true });
    const withArticles = await runCheck(WITH_ARTICLES, { json: true });

    expect(withArticles.log).toEqual(without.log);
    expect(withArticles.error).toEqual(without.error);
    expect(withArticles.exitCode).toBe(without.exitCode);
  });

  it('prints no notice when the pattern names no article extension', async () => {
    const result = await runCheck(KEY_FILES_ONLY);

    expect(articleNotice(result.log)).toEqual([]);
  });

  it('says so and exits 0 for a project that holds only articles', async () => {
    rmSync('categories', { recursive: true });

    const result = await runCheck('**/*.md');

    expect(articleNotice(result.log)).toEqual([
      expect.stringContaining('7 article files are not checked yet (articles/). There are no key files to check.')
    ]);
    expect(result.error).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('still prints a JSON report for a project that holds only articles', async () => {
    rmSync('categories', { recursive: true });

    const result = await runCheck('**/*.md', { json: true });

    expect(result.log).toHaveLength(1);
    expect(JSON.parse(result.log[0])).toMatchObject({ sourceLocale: 'en', sourceFiles: [], keyCount: 0, locales: [] });
    expect(result.exitCode).toBe(0);
  });

  describe('compared with the base branch', () => {
    function git(command: string): void {
      execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${command}`, { stdio: 'pipe' });
    }

    beforeEach(() => {
      execSync('git init -q -b main', { stdio: 'pipe' });
      git('add -A');
      git('commit -qm base');
      git('checkout -q -b feature/articles');
      writeFileSync('articles/en/export-reports.md', '# Export a report\n\nReworded on the branch.\n');
      rmSync('articles/en/notes-en.md');
      rmSync('articles/sv/export-reports.md');
      writeFileSync('articles/en/added.md', '# Added on the branch\n');
      writeFileSync('categories/en/topics.yml', 'en:\n  topics:\n    billing: Billing\n    reports: Reports\n    teams: Teams\n');
      git('add -A');
      git('commit -qm "branch changes"');
    });

    it.each([
      ['text', {}],
      ['JSON', { json: true }],
      ['GitHub', { format: 'github' as const }]
    ])('reports the same %s findings and exit code with and without articles', async (_name, options) => {
      const without = await runCheck(KEY_FILES_ONLY, { ...options, changedOnly: true }, {}, runGit);
      const withArticles = await runCheck(WITH_ARTICLES, { ...options, changedOnly: true }, {}, runGit);

      expect(without.log.join('\n')).toContain('topics.teams');
      expect(withArticles.log.filter(line => !line.includes('article'))).toEqual(without.log);
      expect(withArticles.error).toEqual(without.error);
      expect(withArticles.exitCode).toBe(1);
      expect(without.exitCode).toBe(1);
    });
  });
});
