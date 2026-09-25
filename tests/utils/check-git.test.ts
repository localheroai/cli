import { describe, it, expect } from '@jest/globals';
import { resolveChangeBase, readFileAtRef } from '../../src/utils/check-git.js';
import { fakeGit } from '../helpers/fake-git.js';

const pullRequest = { baseRef: 'main', sha: 'merge' };

describe('resolveChangeBase', () => {
  it("uses the first parent of GitHub's merge commit in a pull request", () => {
    const git = fakeGit({ head: 'merge', headParents: ['base1234567', 'pr'], commits: new Set(['base1234567']) });

    expect(resolveChangeBase(git, { pullRequest, baseBranches: ['main'] })).toEqual({ ref: 'base1234567', label: 'main (base123)' });
    expect(git.calls.some(([command]) => command === 'fetch')).toBe(false);
  });

  it('fetches the base commit a shallow checkout lacks', () => {
    const git = fakeGit({ head: 'merge', headParents: ['base1234567', 'pr'], fetchable: new Set(['base1234567']) });

    expect(resolveChangeBase(git, { pullRequest, baseBranches: ['main'] })).toEqual({ ref: 'base1234567', label: 'main (base123)' });
    expect(git.calls).toContainEqual(['fetch', '--no-tags', '--depth=1', 'origin', 'base1234567']);
  });

  it('says why when the base commit can be neither found nor fetched', () => {
    const git = fakeGit({ head: 'merge', headParents: ['base1234567', 'pr'] });

    const base = resolveChangeBase(git, { pullRequest, baseBranches: ['main'] });

    expect(base).toEqual({ error: expect.stringContaining('base123') });
  });

  it('uses the merge-base with the base branch when HEAD is not the merge commit', () => {
    const git = fakeGit({
      head: 'pr-head',
      headParents: ['a', 'b'],
      refs: { 'origin/main': 'tip' },
      mergeBases: { 'origin/main': 'fork' }
    });

    expect(resolveChangeBase(git, { pullRequest, baseBranches: ['main'] })).toEqual({ ref: 'fork', label: 'origin/main' });
  });

  it('uses the merge-base with the base branch outside a pull request', () => {
    const git = fakeGit({ refs: { main: 'tip' }, mergeBases: { main: 'fork' } });

    expect(resolveChangeBase(git, { pullRequest: null, baseBranches: ['main', 'master'] })).toEqual({ ref: 'fork', label: 'main' });
  });

  it('tries the next base branch when the first does not exist', () => {
    const git = fakeGit({ refs: { 'origin/master': 'tip' }, mergeBases: { 'origin/master': 'fork' } });

    expect(resolveChangeBase(git, { pullRequest: null, baseBranches: ['main', 'master'] })).toEqual({ ref: 'fork', label: 'origin/master' });
  });

  it('does not compare against the base branch tip when there is no merge-base', () => {
    const git = fakeGit({ refs: { main: 'tip' } });

    expect(resolveChangeBase(git, { pullRequest: null, baseBranches: ['main'] })).toEqual({ error: expect.stringContaining('main') });
  });

  it('says when the base branch is missing', () => {
    const git = fakeGit({});

    expect(resolveChangeBase(git, { pullRequest: null, baseBranches: ['develop'] })).toEqual({ error: expect.stringContaining('develop') });
  });

  it('says when this is not a git repository', () => {
    expect(resolveChangeBase(fakeGit({ isRepo: false }), { pullRequest: null, baseBranches: ['main'] })).toEqual({
      error: expect.stringContaining('git repository')
    });
  });
});

describe('readFileAtRef', () => {
  const git = fakeGit({ files: { base: { 'config/locales/en.yml': 'en:\n  a: A\n' } } });

  it('reads a file at a commit, relative to the working directory', () => {
    expect(readFileAtRef(git, 'base', 'config/locales/en.yml')).toBe('en:\n  a: A\n');
  });

  it('returns null for a file the commit does not have', () => {
    expect(readFileAtRef(git, 'base', 'config/locales/sv.yml')).toBeNull();
  });

  it('throws when git fails for another reason', () => {
    expect(() => readFileAtRef(git, 'nope', 'config/locales/en.yml')).toThrow();
  });
});
