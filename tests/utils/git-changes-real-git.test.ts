import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { diffFileKeys } from '../../src/utils/git-changes.js';

describe('diffFileKeys against a real git repository', () => {
  let repo: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(path.join(os.tmpdir(), 'git-changes-'));
    process.chdir(repo);
    execSync('git init -q');
    writeFileSync('existing.yml', 'en:\n  hello: Hello\n');
    execSync('git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm base');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('treats a file missing at the base ref as new, with every key changed', () => {
    writeFileSync('added.i18n.yml', 'en:\n  subject: Increase your visibility\n');

    const diff = diffFileKeys({ path: 'added.i18n.yml', format: 'yml', locale: 'en' }, 'HEAD', false);

    expect(diff).toEqual({ oldFlat: {}, newFlat: { subject: 'Increase your visibility' } });
  });

  it('still throws when the base ref itself is invalid', () => {
    expect(() =>
      diffFileKeys({ path: 'existing.yml', format: 'yml', locale: 'en' }, 'no-such-ref', false)
    ).toThrow();
  });
});
