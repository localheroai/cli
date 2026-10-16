import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const BRANCH = 'feature';
const TOKEN = 'token';
const REPOSITORY = 'acme/shop';
const GIT = '-c user.email=t@t -c user.name=t -c commit.gpgsign=false';
const FR_PATH = 'config/locales/fr.yml';
const EN_PATH = 'config/locales/en.yml';

const mockCreatePullRequestImport = jest.fn<any>();

let importGuard: any;
let leaveOutMovedCells: any;
let sendAlignedImport: any;
let githubService: any;

beforeAll(async () => {
  const actualApi: any = await import('../../src/api/pull-request-imports.js');
  await jest.unstable_mockModule('../../src/api/pull-request-imports.js', () => ({
    ...actualApi,
    createPullRequestImport: mockCreatePullRequestImport
  }));
  ({ importGuard, leaveOutMovedCells } = await import('../../src/utils/import-guard.js'));
  ({ sendAlignedImport } = await import('../../src/utils/aligned-import.js'));
  ({ githubService } = await import('../../src/utils/github.js'));
});

function git(cwd: string, args: string): string {
  return execSync(`git ${GIT} ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), content);
  git(cwd, `add ${file}`);
  git(cwd, `commit -qm "${message}"`);
}

describe('the import guard against a real remote', () => {
  let root: string;
  let remote: string;
  let sibling: string;
  let ours: string;
  let originalCwd: string;
  let log: jest.Mock;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(path.join(os.tmpdir(), 'import-guard-'));
    remote = path.join(root, 'remote.git');
    sibling = path.join(root, 'sibling');
    ours = path.join(root, 'ours');

    execSync(`git init -q --bare -b ${BRANCH} ${remote}`);
    execSync(`git clone -q ${remote} ${sibling}`, { stdio: 'pipe' });
    commitFile(sibling, EN_PATH, 'en:\n  greeting: Hello\n', 'source');
    commitFile(sibling, FR_PATH, 'fr:\n  greeting: Bonjour\n', 'base');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    execSync(`git clone -q ${remote} ${ours}`, { stdio: 'pipe' });
    // The guard and the push both go to github.com with the token; send them to the local remote instead.
    git(ours, `config url.${remote}.insteadOf https://x-access-token:${TOKEN}@github.com/${REPOSITORY}.git`);

    log = jest.fn();
    mockCreatePullRequestImport.mockReset();
    mockCreatePullRequestImport.mockResolvedValue({ imported_count: 1, skipped: [] });
    importGuard.setDependencies({
      env: { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: BRANCH, GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: TOKEN },
      fetchActionToken: async () => ({ token: null })
    });
    const gitEnv = {
      ...process.env,
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false'
    };
    githubService.setDependencies({
      exec: (cmd: string, options: any) => execSync(cmd, { ...options, env: gitEnv }),
      env: { GITHUB_REPOSITORY: REPOSITORY },
      console: { log, warn: jest.fn(), error: jest.fn() }
    });
    process.chdir(ours);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the full history, so our commit still replays onto an unrelated newer commit and the aligned import is sent', async () => {
    commitFile(sibling, 'README.md', 'docs\n', 'unrelated');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    importGuard.recordBaseline();
    const edits = [{
      path: FR_PATH, source_path: EN_PATH, locale: 'fr', format: 'yml',
      changes: [{ key: 'greeting', status: 'added', value: 'Bonjour', source_value: 'Hello' }]
    }];

    expect(await leaveOutMovedCells(edits, 'en', { log })).toEqual(edits);

    commitFile(ours, FR_PATH, 'fr:\n  greeting: Salut\n', 'aligned');
    const outcome = await githubService.pushWithRetry(BRANCH, TOKEN);

    expect(outcome).toBe('pushed');
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('replayed the translation commit');
    expect(git(remote, `log --format=%s ${BRANCH}`).split('\n')).toEqual(['aligned', 'unrelated', 'base', 'source']);

    await sendAlignedImport([{
      locale: 'fr', source_path: EN_PATH, target_path: FR_PATH, format: 'yml', key: 'greeting',
      previous_source: 'Hi', source: 'Hello', target_base: 'Bonjour', target_current: 'Bonjour', value: 'Salut'
    }], { projectId: 'proj', branch: BRANCH, jobGroupId: 'grp', sourceLocale: 'en', valuesFrom: 'our-commit' }, { console: { log } });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestImport.mock.calls[0][0].files[0].changes[0]).toMatchObject({ key: 'greeting', value: 'Salut' });
    expect(existsSync(path.join(ours, '.git', 'shallow'))).toBe(false);
  });

  it('on a merge-commit checkout of an unchanged branch, sends values the pipeline has not committed yet', async () => {
    git(ours, 'checkout -q -b main');
    commitFile(ours, 'README.md', 'docs\n', 'base branch work');
    git(ours, `checkout -q --detach origin/${BRANCH}`);
    git(ours, 'merge -q --no-ff -m merge main');
    importGuard.recordBaseline();
    writeFileSync(path.join(ours, FR_PATH), 'fr:\n  greeting: Salut\n');

    expect(git(ours, 'rev-parse HEAD')).not.toBe(git(remote, `rev-parse ${BRANCH}`));
    await sendAlignedImport([{
      locale: 'fr', source_path: EN_PATH, target_path: FR_PATH, format: 'yml', key: 'greeting',
      previous_source: 'Hi', source: 'Hello', target_base: 'Bonjour', target_current: 'Bonjour', value: 'Salut'
    }], { projectId: 'proj', branch: BRANCH, jobGroupId: 'grp', sourceLocale: 'en', valuesFrom: 'working-tree' }, { console: { log } });

    expect(mockCreatePullRequestImport).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestImport.mock.calls[0][0].files[0].changes[0]).toMatchObject({ key: 'greeting', value: 'Salut' });
  });

  it('on a merge-ref checkout of an unchanged PR branch, sends its French edit although main reworded the English', async () => {
    commitFile(sibling, FR_PATH, 'fr:\n  greeting: Salut\n', 'PR edit');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    git(ours, 'checkout -q -b main');
    commitFile(ours, EN_PATH, 'en:\n  greeting: Hello there\n', 'base branch rewords');
    git(ours, 'fetch -q origin');
    git(ours, `checkout -q --detach origin/${BRANCH}`);
    git(ours, 'merge -q --no-ff -m merge main');
    importGuard.recordBaseline();
    const edits = [{
      path: FR_PATH, source_path: EN_PATH, locale: 'fr', format: 'yml',
      changes: [{ key: 'greeting', status: 'updated', value: 'Salut', source_value: 'Hello there' }]
    }];

    expect(await leaveOutMovedCells(edits, 'en', { log })).toEqual(edits);
    expect(log).not.toHaveBeenCalled();
  });

  it('after replaying our commit past a push that changed only the source, leaves out the stale source text', async () => {
    importGuard.recordBaseline();
    commitFile(sibling, EN_PATH, 'en:\n  greeting: Hello there\n', 'reword');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    commitFile(ours, FR_PATH, 'fr:\n  greeting: Salut\n', 'aligned');

    expect(await githubService.pushWithRetry(BRANCH, TOKEN)).toBe('pushed');
    expect(git(ours, 'rev-parse HEAD')).toBe(git(remote, `rev-parse ${BRANCH}`));

    await sendAlignedImport([{
      locale: 'fr', source_path: EN_PATH, target_path: FR_PATH, format: 'yml', key: 'greeting',
      previous_source: 'Hi', source: 'Hello', target_base: 'Bonjour', target_current: 'Bonjour', value: 'Salut'
    }], { projectId: 'proj', branch: BRANCH, jobGroupId: 'grp', sourceLocale: 'en', valuesFrom: 'our-commit' }, { console: { log } });

    expect(mockCreatePullRequestImport).not.toHaveBeenCalled();
  });

  it('leaves out a value our commit landed when a newer commit set it back before the import', async () => {
    importGuard.recordBaseline();
    commitFile(ours, FR_PATH, 'fr:\n  greeting: Salut\n', 'aligned');
    expect(await githubService.pushWithRetry(BRANCH, TOKEN)).toBe('pushed');
    git(sibling, `pull -q origin ${BRANCH}`);
    commitFile(sibling, FR_PATH, 'fr:\n  greeting: Bonjour\n', 'restore');
    git(sibling, `push -q origin HEAD:${BRANCH}`);

    await sendAlignedImport([{
      locale: 'fr', source_path: EN_PATH, target_path: FR_PATH, format: 'yml', key: 'greeting',
      previous_source: 'Hi', source: 'Hello', target_base: 'Bonjour', target_current: 'Bonjour', value: 'Salut'
    }], { projectId: 'proj', branch: BRANCH, jobGroupId: 'grp', sourceLocale: 'en', valuesFrom: 'our-commit' }, { console: { log } });

    expect(mockCreatePullRequestImport).not.toHaveBeenCalled();
  });

  it('leaves out a value a sync committed after the checkout, reading the real tip', async () => {
    commitFile(sibling, FR_PATH, 'fr:\n  greeting: Bonjour à tous\n', 'sync');
    git(sibling, `push -q origin HEAD:${BRANCH}`);
    importGuard.recordBaseline();

    const kept = await leaveOutMovedCells([{
      path: FR_PATH, source_path: EN_PATH, locale: 'fr', format: 'yml',
      changes: [{ key: 'greeting', status: 'updated', value: 'Bonjour', source_value: 'Hello' }]
    }], 'en', { log });

    expect(kept).toEqual([]);
    expect(git(ours, 'config --get remote.origin.url')).toBe(remote);
    expect(existsSync(path.join(ours, '.git', 'shallow'))).toBe(false);
  });
});
