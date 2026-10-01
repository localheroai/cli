import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';
import * as realFs from 'fs';
import { promises as fsPromises } from 'fs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import nodePath from 'path';
import { githubService } from '../../src/utils/github.js';
import { StaleHeadError } from '../../src/utils/github-graphql.js';

// GitHub's createCommitOnBranch resolves additions[].path from the REPOSITORY
// ROOT, while every path the CLI holds is relative to localhero.json, i.e. to
// the working directory. At the repository root the two coincide, so this only
// surfaced once a monorepo put the config in a subdirectory: the signed commit
// wrote its files to the wrong place and the run reported success (#791).
describe('signed commits from a subdirectory', () => {
  let repo: string;
  let originalCwd: string;
  let createSignedCommit: any;
  let fetchChangedPaths: any;

  const git = (cmd: string, cwd?: string) =>
    execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${cmd}`, {
      stdio: 'pipe',
      cwd
    });

  const wire = (overrides: Record<string, unknown> = {}) => {
    githubService.setDependencies({
      exec: ((cmd: string, opts: any) => execSync(cmd, { ...opts, stdio: 'pipe' })) as any,
      fs: { ...realFs, readFile: fsPromises.readFile } as any,
      path: nodePath as any,
      env: { GITHUB_REPOSITORY: 'acme/monorepo', GITHUB_ACTIONS: 'true' } as any,
      console: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
      configService: {
        getProjectConfig: async () => ({ github: { signedCommits: true } })
      } as any,
      fetchGitHubInstallationToken: (jest.fn() as any).mockResolvedValue('ghs_token'),
      createSignedCommit,
      fetchBranchHead: (jest.fn() as any).mockResolvedValue('headsha'),
      fetchChangedPaths,
      ...overrides
    } as any);
  };

  beforeEach(() => {
    createSignedCommit = (jest.fn() as any).mockResolvedValue({ oid: 'newsha' });
    fetchChangedPaths = (jest.fn() as any).mockResolvedValue([]);

    originalCwd = process.cwd();
    repo = mkdtempSync(nodePath.join(os.tmpdir(), 'signed-subdir-'));
    process.chdir(repo);
    execSync('git init -q');

    mkdirSync(nodePath.join('apps', 'portal', 'public', 'locales'), { recursive: true });
    writeFileSync(nodePath.join('apps', 'portal', 'public', 'locales', 'de.json'), '{"a":"A"}');
    writeFileSync(nodePath.join('apps', 'portal', 'localhero.json'), '{"projectId":"p"}');
    git('add .');
    git('commit -qm base');

    // A monorepo runs the CLI from the app directory, as a matrix job does.
    process.chdir(nodePath.join(repo, 'apps', 'portal'));

    // After the repo and cwd exist: wire() captures neither, but a test that
    // re-wires with different mocks calls it again itself.
    wire();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('sends paths relative to the repository root, not the working directory', async () => {
    writeFileSync(nodePath.join('public', 'locales', 'de.json'), '{"a":"B"}');

    const result = await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['public/locales/de.json'],
      message: 'Update translations'
    });

    expect(result).toBe('new');
    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions.map((a: any) => a.path))
      .toEqual(['apps/portal/public/locales/de.json']);
  });

  it('reads the file from the working directory while sending the repository path', async () => {
    writeFileSync(nodePath.join('public', 'locales', 'de.json'), '{"a":"local"}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['public/locales/de.json'],
      message: 'Update translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    const contents = Buffer.from(sent.fileChanges.additions[0].contents, 'base64').toString();
    expect(contents).toBe('{"a":"local"}');
  });

  it('leaves paths alone when the working directory is the repository root', async () => {
    process.chdir(repo);
    writeFileSync(nodePath.join('apps', 'portal', 'public', 'locales', 'de.json'), '{"a":"B"}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['apps/portal/public/locales/de.json'],
      message: 'Update translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions[0].path).toBe('apps/portal/public/locales/de.json');
  });

  // #90 compares the paths it is about to commit against the paths a newer push
  // changed, taken from the GitHub compare API, which speaks repository-root
  // paths. Comparing those against working-directory paths never matched, so
  // the guard reported "safe" and overwrote the newer commit.
  it('detects an overlap with a newer push, which needs both sides in repository paths', async () => {
    writeFileSync(nodePath.join('public', 'locales', 'de.json'), '{"a":"B"}');

    createSignedCommit = (jest.fn() as any)
      .mockRejectedValueOnce(new StaleHeadError('stale'))
      .mockResolvedValue({ oid: 'newsha' });
    fetchChangedPaths = (jest.fn() as any)
      .mockResolvedValue(['apps/portal/public/locales/de.json']);
    wire();

    const result = await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['public/locales/de.json'],
      message: 'Update translations'
    });

    expect(result).toBe('skipped-overlap');
  });

  it('sends the project config at its own path, not the repository root', async () => {
    writeFileSync('localhero.json', '{"projectId":"p","changed":true}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['localhero.json'],
      message: 'Sync translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions[0].path).toBe('apps/portal/localhero.json');
  });

  it('refuses a path that escapes the repository rather than committing it elsewhere', async () => {
    const outside = nodePath.join(os.tmpdir(), `outside-${Date.now()}.json`);
    writeFileSync(outside, '{"secret":true}');

    await expect(
      githubService.apiCommitAndPush({
        branchName: 'feature',
        filePaths: [outside],
        message: 'Update translations'
      })
    ).rejects.toThrow(/outside the repository/i);

    rmSync(outside, { force: true });
  });

  // A path that does not exist used to claim its destination before the
  // existence check, so the real file mapping to the same place was skipped and
  // silently left out of the commit.
  it('still sends the file when an earlier path maps to it but does not exist', async () => {
    writeFileSync(nodePath.join('public', 'locales', 'de.json'), '{"a":"B"}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['missing/../public/locales/de.json', 'public/locales/de.json'],
      message: 'Update translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions).toHaveLength(1);
    expect(sent.fileChanges.additions[0].path).toBe('apps/portal/public/locales/de.json');
  });

  it('refuses a path that escapes the repository upwards', async () => {
    writeFileSync(nodePath.join(repo, 'escaped.json'), '{"a":"A"}');

    await expect(
      githubService.apiCommitAndPush({
        branchName: 'feature',
        filePaths: ['../../../escaped.json'],
        message: 'Update translations'
      })
    ).rejects.toThrow(/outside the repository/i);
  });

  it('accepts an absolute path that lies inside the working directory', async () => {
    // commands/ci.ts resolves each synced file to an absolute path and keeps
    // the ones that do not escape cwd, so these reach the commit as absolutes.
    const absolute = nodePath.join(process.cwd(), 'public', 'locales', 'de.json');
    writeFileSync(absolute, '{"a":"B"}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: [absolute],
      message: 'Update translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions[0].path).toBe('apps/portal/public/locales/de.json');
  });

  // '', '.', './' and 'public/..' all normalise to the app directory itself.
  // None names a file; unrejected they pass existsSync and die in readFile with
  // a bare EISDIR.
  it.each(['.', './', '', 'public/..'])(
    'refuses %p, which resolves to the directory rather than a file',
    async (input) => {
      await expect(
        githubService.apiCommitAndPush({
          branchName: 'feature',
          filePaths: [input],
          message: 'Update translations'
        })
      ).rejects.toThrow(/directory, not a file/i);
    }
  );

  it('sends one addition when the same file arrives spelled two ways', async () => {
    writeFileSync(nodePath.join('public', 'locales', 'de.json'), '{"a":"B"}');

    await githubService.apiCommitAndPush({
      branchName: 'feature',
      filePaths: ['public/locales/de.json', './public/locales/de.json'],
      message: 'Update translations'
    });

    const sent = createSignedCommit.mock.calls[0][0];
    expect(sent.fileChanges.additions).toHaveLength(1);
  });

});
