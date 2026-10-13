import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';
import * as realFs from 'fs';
import { promises as fsPromises } from 'fs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import nodePath from 'path';
import { githubService } from '../../src/utils/github.js';

// translate rewrites lastSyncedAt in localhero.json on every run. A subproject
// whose translation path is its own directory ("paths": ["./"]) used to sweep
// that change into each translation commit, so two PRs from the same base both
// edited the same line of localhero.json and the second one to merge conflicted.
describe('translation commits from a subproject whose translation path holds localhero.json', () => {
  let repo: string;
  let originalCwd: string;
  let createSignedCommit: any;


  const git = (cmd: string) =>
    execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${cmd}`, { stdio: 'pipe' })
      .toString().trim();

  const wire = (signedCommits: boolean) => {
    // configureGitUser writes --global config; keep it out of the real one.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: `${repo}.gitconfig`,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false'
    };
    githubService.setDependencies({
      exec: ((cmd: string, opts: any) => execSync(cmd, { ...opts, stdio: 'pipe', env })) as any,
      fs: { ...realFs, readFile: fsPromises.readFile } as any,
      path: nodePath as any,
      env: { GITHUB_REPOSITORY: 'acme/monorepo', GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature' } as any,
      console: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
      configService: {
        getProjectConfig: async () => ({ github: { signedCommits } })
      } as any,
      fetchGitHubInstallationToken: (jest.fn() as any).mockResolvedValue('ghs_token'),
      createSignedCommit,
      fetchBranchHead: (jest.fn() as any).mockResolvedValue('headsha'),
      fetchChangedPaths: (jest.fn() as any).mockResolvedValue([])
    } as any);
  };

  beforeEach(() => {
    createSignedCommit = (jest.fn() as any).mockResolvedValue({ oid: 'newsha' });

    originalCwd = process.cwd();
    repo = mkdtempSync(nodePath.join(os.tmpdir(), 'translate-commit-config-'));
    process.chdir(repo);
    execSync('git init -q');

    const subproject = nodePath.join('config', 'locales', 'pressroom');
    mkdirSync(subproject, { recursive: true });
    writeFileSync(nodePath.join(subproject, 'de.yml'), 'de:\n  a: A\n');
    writeFileSync(nodePath.join(subproject, 'localhero.json'), '{"projectId":"p"}');
    git('add .');
    git('commit -qm base');

    process.chdir(nodePath.join(repo, subproject));
    writeFileSync('de.yml', 'de:\n  a: B\n');
    writeFileSync('localhero.json', '{"projectId":"p","lastSyncedAt":"2026-10-13T00:00:00.000Z"}');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}.gitconfig`, { force: true });
  });

  it('leaves localhero.json out of a plain git commit', async () => {
    wire(false);
    jest.spyOn(githubService, 'getTokenForPush').mockResolvedValue('token');
    jest.spyOn(githubService, 'pushWithRetry').mockResolvedValue('pushed');

    const result = await githubService.autoCommitChanges('./');

    expect(result).toBe('new');
    expect(git('show --name-only --format= HEAD')).toBe('config/locales/pressroom/de.yml');
    expect(git('status --porcelain')).toBe('M config/locales/pressroom/localhero.json');
  });

  it('leaves localhero.json out of a signed commit', async () => {
    wire(true);

    const result = await githubService.autoCommitChanges('./');

    expect(result).toBe('new');
    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions.map((a: any) => a.path))
      .toEqual(['config/locales/pressroom/de.yml']);
  });
});
