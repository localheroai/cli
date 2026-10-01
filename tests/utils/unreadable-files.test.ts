import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { detectTargetChanges } from '../../src/utils/target-changes.js';
import {
  resetUnreadableFiles,
  getUnreadableFiles,
  recordUnreadableFile
} from '../../src/utils/unreadable-files.js';

// A file the run was configured to read but could not is not the same as a file
// with no changes. Before #779 both looked like "nothing to do", so a run that
// read none of its files still reported success and exited 0.
describe('unreadable file tracking', () => {
  let repo: string;
  let originalCwd: string;

  const git = (cmd: string) =>
    execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${cmd}`, { stdio: 'pipe' });

  beforeEach(() => {
    resetUnreadableFiles();
    originalCwd = process.cwd();
    repo = mkdtempSync(path.join(os.tmpdir(), 'unreadable-'));
    process.chdir(repo);
    execSync('git init -q');
    mkdirSync('locales', { recursive: true });
    writeFileSync(path.join('locales', 'en.json'), JSON.stringify({ greeting: 'Hello' }));
    writeFileSync(path.join('locales', 'sv.json'), JSON.stringify({ greeting: 'Hej' }));
    git('add .');
    git('commit -qm base');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
    resetUnreadableFiles();
  });

  it('starts empty and records a path once, however often it is reported', () => {
    expect(getUnreadableFiles()).toEqual([]);

    recordUnreadableFile('locales/sv.json');
    recordUnreadableFile('locales/sv.json');

    expect(getUnreadableFiles()).toEqual(['locales/sv.json']);
  });

  it('reset clears everything recorded so far', () => {
    recordUnreadableFile('locales/sv.json');
    resetUnreadableFiles();

    expect(getUnreadableFiles()).toEqual([]);
  });

  it('records a target file whose contents cannot be parsed', () => {
    // Valid at the base ref, unparsable now: diffFileKeys throws on the new side
    // rather than treating it as missing, which is what reaches the recorder.
    writeFileSync(path.join('locales', 'sv.json'), '{ not json at all');

    const config = {
      schemaVersion: '1.0',
      projectId: 'p',
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: { paths: ['locales'], baseBranch: 'HEAD' },
      lastSyncedAt: null
    } as any;

    detectTargetChanges(
      [{ path: 'locales/en.json', format: 'json', locale: 'en' }],
      { sv: [{ path: 'locales/sv.json', format: 'json', locale: 'sv' }] },
      config,
      false
    );

    expect(getUnreadableFiles()).toContain('locales/sv.json');
  });

  it('records nothing when every file reads cleanly', () => {
    const config = {
      schemaVersion: '1.0',
      projectId: 'p',
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: { paths: ['locales'], baseBranch: 'HEAD' },
      lastSyncedAt: null
    } as any;

    detectTargetChanges(
      [{ path: 'locales/en.json', format: 'json', locale: 'en' }],
      { sv: [{ path: 'locales/sv.json', format: 'json', locale: 'sv' }] },
      config,
      false
    );

    expect(getUnreadableFiles()).toEqual([]);
  });
});
