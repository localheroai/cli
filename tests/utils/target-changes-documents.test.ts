import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { detectTargetChanges } from '../../src/utils/target-changes.js';
import { findTranslationFiles } from '../../src/utils/files.js';
import type { ProjectConfig, TranslationFilesResult } from '../../src/types/index.js';

// Each test builds a real git repository; on a busy machine that outlasts the default five seconds.
jest.setTimeout(30000);

const config = {
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['categories/', 'articles/'], pattern: '**/*.{yml,md}' }
} as ProjectConfig;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commitAll(message: string): void {
  execSync(`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm "${message}"`, { stdio: 'pipe' });
}

function manyKeys(locale: string, count: number, suffix: string): string {
  const lines = Array.from({ length: count }, (_, i) => `  key_${i}: Value ${i}${suffix}`);
  return `${locale}:\n${lines.join('\n')}\n`;
}

async function detect() {
  const { sourceFiles, targetFilesByLocale } = await findTranslationFiles(config, {
    returnFullResult: true,
    documents: 'include'
  }) as TranslationFilesResult;
  return detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
}

describe('detectTargetChanges with articles', () => {
  let directory: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'target-changes-documents-')));
    process.chdir(directory);
    execSync('git init -q -b main', { stdio: 'pipe' });
    write('categories/en/topics.yml', 'en:\n  topics: Topics\n');
    write('categories/sv/topics.yml', 'sv:\n  topics: Ämnen\n');
    write('articles/en/topics.md', '# Topics\n\nA list of topics.\n');
    commitAll('base');
    execSync('git checkout -q -b feature/articles', { stdio: 'pipe' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  });

  it('pairs an article with the article at its source path, not with a key file of the same name', async () => {
    write('articles/sv/topics.md', '# Ämnen\n\nEn lista med ämnen.\n');
    write('categories/sv/topics.yml', 'sv:\n  topics: Rubriker\n');

    const changes = await detect();

    expect(changes).toEqual(expect.arrayContaining([
      {
        path: 'articles/sv/topics.md',
        source_path: 'articles/en/topics.md',
        locale: 'sv',
        format: 'markdown',
        changes: [{ key: 'topics.md', status: 'added', value: '# Ämnen\n\nEn lista med ämnen.\n' }]
      },
      {
        path: 'categories/sv/topics.yml',
        source_path: 'categories/en/topics.yml',
        locale: 'sv',
        format: 'yml',
        changes: [{ key: 'topics', status: 'updated', value: 'Rubriker', old_value: 'Ämnen', source_value: 'Topics' }]
      }
    ]));
    expect(changes).toHaveLength(2);
  });

  it('reports no change for an article that only changed its line endings', async () => {
    write('articles/en/topics.md', '# Topics\r\n\r\nA list of topics.\r\n');

    expect(await detect()).toEqual([]);
  });

  it('never sends an article that holds only whitespace', async () => {
    write('articles/sv/topics.md', '\n\n');
    write('articles/en/topics.md', ' \n');

    expect(await detect()).toEqual([]);
  });

  it('skips an article translation without an English article at its source path', async () => {
    write('articles/sv/orphan.md', '# Ensam\n');

    expect(await detect()).toEqual([]);
  });

  it('keeps key files under their change limit however many articles the pull request holds', async () => {
    write('categories/en/bulk.yml', manyKeys('en', 990, ''));
    write('categories/sv/bulk.yml', manyKeys('sv', 990, ''));
    commitAll('many keys');
    write('categories/sv/bulk.yml', manyKeys('sv', 990, ' (ny)'));
    for (let i = 0; i < 20; i++) {
      write(`articles/en/guide-${i}.md`, `# Guide ${i}\n`);
      write(`articles/sv/guide-${i}.md`, `# Guide ${i} på svenska\n`);
    }

    const changes = await detect();

    expect(changes).not.toBeNull();
    expect(changes?.filter(file => file.format === 'markdown')).toHaveLength(20);
    expect(changes?.find(file => file.path === 'categories/sv/bulk.yml')?.changes).toHaveLength(990);
  });
});
