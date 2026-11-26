import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { findDocumentsToResend } from '../../src/utils/document-resend.js';
import { findTranslationFiles } from '../../src/utils/files.js';
import type { ProjectConfig, TranslationFilesResult } from '../../src/types/index.js';

const config = {
  projectId: 'help-center',
  sourceLocale: 'en',
  outputLocales: ['sv'],
  translationFiles: { paths: ['articles/'], pattern: '**/*.md' }
} as ProjectConfig;

const ENGLISH = 'articles/en/invite-teammates.md';
const SWEDISH = 'articles/sv/invite-teammates.md';
const FIRST = '# Invite teammates\n\nOpen **Team**.\n';
const SECOND = '# Invite teammates\n\nOpen **Team** and press Invite.\n';

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commitAll(message: string): void {
  execSync(`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm "${message}"`, { stdio: 'pipe' });
}

async function resend() {
  const { sourceFiles, targetFilesByLocale } = await findTranslationFiles(config, {
    returnFullResult: true,
    documents: 'include'
  }) as TranslationFilesResult;
  return findDocumentsToResend(sourceFiles, targetFilesByLocale, config);
}

describe('findDocumentsToResend', () => {
  let directory: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'document-resend-')));
    process.chdir(directory);
    execSync('git init -q -b main && git config core.autocrlf false', { stdio: 'pipe' });
    write('articles/en/export-reports.md', '# Export a report\n');
    write('articles/sv/export-reports.md', '# Exportera en rapport\n');
    commitAll('base');
    execSync('git checkout -q -b feature/new-article', { stdio: 'pipe' });
    write(ENGLISH, FIRST);
    commitAll('add an article');
    write(SWEDISH, '# Bjud in kollegor\n\nÖppna **Team**.\n');
    commitAll('Update translations');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  });

  it('sends nothing while the English is what the translation was made from', async () => {
    expect(await resend()).toEqual({});
  });

  it('sends a new article again when its English changed after the translation commit', async () => {
    write(ENGLISH, SECOND);
    commitAll('reword the new article');

    expect(await resend()).toEqual({
      [`sv:${ENGLISH}`]: {
        locale: 'sv',
        path: ENGLISH,
        targetPath: SWEDISH,
        keys: { 'invite-teammates.md': { value: SECOND } },
        keyCount: 1
      }
    });
  });

  it('sends it again when one commit changed the English and the Swedish together', async () => {
    write(ENGLISH, SECOND);
    write(SWEDISH, '# Bjud in kollegor\n\nÖppna **Team** och tryck på Bjud in.\n');
    commitAll('reword both by hand');

    expect(Object.keys(await resend())).toEqual([`sv:${ENGLISH}`]);
  });

  it('sends nothing when only the Swedish was edited later', async () => {
    write(SWEDISH, '# Bjud in dina kollegor\n\nÖppna **Team**.\n');
    commitAll('polish the Swedish');

    expect(await resend()).toEqual({});
  });

  it('still sends it when a sync wrote the Swedish after the English changed', async () => {
    write(ENGLISH, SECOND);
    commitAll('reword the new article');
    write(SWEDISH, '# Bjud in kollegor\n\nRedigerad på Localhero.\n');
    commitAll('Sync translations');

    expect(Object.keys(await resend())).toEqual([`sv:${ENGLISH}`]);
  });

  it('sends nothing without a translation commit to compare with', async () => {
    execSync('git reset -q --soft HEAD~2', { stdio: 'pipe' });
    commitAll('article and translation squashed');
    write(ENGLISH, SECOND);
    commitAll('reword the new article');

    expect(await resend()).toEqual({});
  });

  it('sends nothing while the Swedish has uncommitted changes', async () => {
    write(ENGLISH, SECOND);
    commitAll('reword the new article');
    write(SWEDISH, '# Bjud in kollegor\n\nPågående ändring.\n');

    expect(await resend()).toEqual({});
  });

  it('never sends an article that was already on the base branch', async () => {
    write('articles/en/export-reports.md', '# Export a report\n\nReworded.\n');
    commitAll('reword an existing article');
    write('articles/sv/export-reports.md', '# Exportera en rapport\n\nOmskriven.\n');
    commitAll('Update translations');
    write('articles/en/export-reports.md', '# Export a report\n\nReworded again.\n');
    commitAll('reword it again');

    expect(await resend()).toEqual({});
  });

  it('treats a line ending change in the English as no change', async () => {
    write(ENGLISH, FIRST.replace(/\n/g, '\r\n'));
    commitAll('line endings');

    expect(await resend()).toEqual({});
  });
});
