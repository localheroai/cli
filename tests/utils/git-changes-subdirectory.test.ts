import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { diffFileKeys, hasFileChanged, enumerateDeletedSourceFiles } from '../../src/utils/git-changes.js';

// A monorepo runs the CLI from the app directory, not the repository root, so
// every path in localhero.json is relative to the app. `git show <ref>:<path>`
// resolves from the repository root instead, which silently skipped every file
// and still reported success (#779).
describe('git operations from a subdirectory', () => {
  let repo: string;
  let originalCwd: string;
  const app = path.join('apps', 'editor');
  const locales = path.join(app, 'public', 'locale');

  const git = (cmd: string) =>
    execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${cmd}`, { stdio: 'pipe' });

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(path.join(os.tmpdir(), 'git-subdir-'));
    process.chdir(repo);
    execSync('git init -q');

    mkdirSync(locales, { recursive: true });
    writeFileSync(path.join(locales, 'en.json'), JSON.stringify({ hello: 'Hello' }, null, 2));
    writeFileSync(path.join(locales, 'sv.json'), JSON.stringify({ hello: 'Hej' }, null, 2));
    git('add .');
    git('commit -qm base');

    // The CLI is invoked from the app directory, as a monorepo matrix job does.
    process.chdir(path.join(repo, app));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('diffs a changed file using a path relative to the working directory', () => {
    writeFileSync(
      path.join('public', 'locale', 'en.json'),
      JSON.stringify({ hello: 'Hello', goodbye: 'Goodbye' }, null, 2)
    );

    const diff = diffFileKeys(
      { path: 'public/locale/en.json', format: 'json', locale: 'en' },
      'HEAD',
      false
    );

    expect(diff.oldFlat).toEqual({ hello: 'Hello' });
    expect(diff.newFlat).toEqual({ hello: 'Hello', goodbye: 'Goodbye' });
  });

  it('reports an unchanged file as unchanged rather than as entirely new', () => {
    // The bug made every file look new, because reading the base version threw
    // and the catch treated the failure as "changed".
    const changed = hasFileChanged({ path: 'public/locale/sv.json', format: 'json', locale: 'sv' }, 'HEAD');

    expect(changed).toBe(false);
  });

  it('sees a real change in a file that exists at the base ref', () => {
    writeFileSync(path.join('public', 'locale', 'sv.json'), JSON.stringify({ hello: 'Hejsan' }, null, 2));

    const changed = hasFileChanged({ path: 'public/locale/sv.json', format: 'json', locale: 'sv' }, 'HEAD');

    expect(changed).toBe(true);
  });

  it('lists a deleted source file with a path relative to the working directory', () => {
    // `git diff --name-only` prints repo-root-relative paths, which do not match
    // the cwd-relative paths the rest of the CLI works in. Only source-language
    // deletions are enumerated, so this deletes the source file.
    git(`rm -q ${path.join('public', 'locale', 'en.json')}`);
    git('commit -qm "drop en"');

    const config = {
      schemaVersion: '1.0',
      projectId: 'x',
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: { paths: ['public/locale'] },
      lastSyncedAt: null
    } as any;

    const deleted = enumerateDeletedSourceFiles(config, 'HEAD~1', false);

    expect(deleted.map((f: any) => f.path)).toEqual(['public/locale/en.json']);
  });
});
