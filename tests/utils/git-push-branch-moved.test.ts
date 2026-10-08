import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { githubService } from '../../src/utils/github.js';

const BRANCH = 'feature';
const GIT = '-c user.email=t@t -c user.name=t -c commit.gpgsign=false';

function git(cwd: string, args: string): string {
  return execSync(`git ${GIT} ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), content);
  git(cwd, `add ${file}`);
  git(cwd, `commit -qm "${message}"`);
}

function remoteLog(remote: string): string[] {
  return git(remote, `log --format=%s ${BRANCH}`).split('\n');
}

describe('rebaseOntoMovedBranch against a real remote', () => {
  let root: string;
  let remote: string;
  let sibling: string;
  let ours: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(path.join(os.tmpdir(), 'push-moved-'));
    remote = path.join(root, 'remote.git');
    sibling = path.join(root, 'sibling');
    ours = path.join(root, 'ours');

    execSync(`git init -q --bare -b ${BRANCH} ${remote}`);
    execSync(`git clone -q ${remote} ${sibling}`, { stdio: 'pipe' });
    commitFile(sibling, 'apps/editor/public/locale/sv.json', '{}\n', 'base');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    execSync(`git clone -q ${remote} ${ours}`, { stdio: 'pipe' });

    // In CI configureGitUser sets the identity before committing; here the rebase needs one too.
    const gitEnv = {
      ...process.env,
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false'
    };
    githubService.setDependencies({
      exec: (cmd, options) => execSync(cmd, { ...options, env: gitEnv }),
      env: {},
      console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    });
    process.chdir(ours);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('replays our commit onto a tip that moved forward without touching our files', async () => {
    commitFile(sibling, 'apps/editor/public/locale/de.json', '{}\n', 'editor translations');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    commitFile(ours, 'apps/portal/public/locales/sv.json', '{}\n', 'portal translations');

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);
    git(ours, `push -q origin HEAD:${BRANCH}`);

    expect(outcome).toBe('rebased');
    expect(remoteLog(remote)).toEqual(['portal translations', 'editor translations', 'base']);
  });

  it('replays with the unstaged localhero.json change translate leaves behind, and keeps it', async () => {
    commitFile(sibling, 'localhero.json', '{"lastSyncedAt": "old"}\n', 'config');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    git(ours, `pull -q origin ${BRANCH}`);
    commitFile(sibling, 'apps/editor/public/locale/de.json', '{}\n', 'editor translations');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    commitFile(ours, 'apps/portal/public/locales/sv.json', '{}\n', 'portal translations');
    writeFileSync(path.join(ours, 'localhero.json'), '{"lastSyncedAt": "new"}\n');

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);
    git(ours, `push -q origin HEAD:${BRANCH}`);

    expect(outcome).toBe('rebased');
    expect(remoteLog(remote)).toEqual(['portal translations', 'editor translations', 'config', 'base']);
    expect(git(ours, 'status --porcelain')).toBe('M localhero.json');
  });

  it('skips when the newer commits touched one of our files', async () => {
    commitFile(sibling, 'apps/editor/public/locale/sv.json', '{"a": 1}\n', 'someone else edits sv');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    commitFile(ours, 'apps/editor/public/locale/sv.json', '{"a": 2}\n', 'our sv');

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);

    expect(outcome).toBe('skipped-overlap');
    expect(git(ours, 'log -1 --format=%s')).toBe('our sv');
    expect(git(ours, 'status --porcelain')).toBe('');
  });

  it('treats a renamed file as touched, so our edits are not carried to the new name', async () => {
    git(sibling, 'mv apps/editor/public/locale/sv.json apps/editor/public/locale/sv-SE.json');
    git(sibling, 'commit -qm "rename sv"');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    commitFile(ours, 'apps/editor/public/locale/sv.json', '{"a": 2}\n', 'our sv');

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);

    expect(outcome).toBe('skipped-overlap');
  });

  it('skips rather than replay a commit someone removed with a force-push', async () => {
    commitFile(sibling, 'app/code.js', 'removed later\n', 'code change');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    git(ours, `pull -q origin ${BRANCH}`);
    commitFile(ours, 'apps/portal/public/locales/sv.json', '{}\n', 'portal translations');
    git(sibling, 'reset -q --hard HEAD~1');
    commitFile(sibling, 'README.md', 'docs\n', 'replacement');
    git(sibling, `push -q --force origin HEAD:${BRANCH}`);

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);

    expect(outcome).toBe('skipped-uncertain');
    expect(remoteLog(remote)).toEqual(['replacement', 'base']);
  });

  it('skips when the branch cannot be fetched', async () => {
    commitFile(ours, 'apps/portal/public/locales/sv.json', '{}\n', 'portal translations');
    git(ours, 'remote set-url origin /nonexistent/remote.git');

    const outcome = await githubService.rebaseOntoMovedBranch(BRANCH);

    expect(outcome).toBe('skipped-uncertain');
    expect(git(ours, 'log -1 --format=%s')).toBe('portal translations');
  });
});
