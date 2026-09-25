import { execFileSync } from 'child_process';
import path from 'path';

export type GitRunner = (args: string[]) => string;

export const runGit: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export type ChangeBase = { ref: string; label: string } | { error: string };

export interface ChangeBaseOptions {
  /** Set on a GitHub pull request run: its base branch and the merge commit GitHub checked out. */
  pullRequest: { baseRef: string; sha?: string } | null;
  baseBranches: string[];
}

const SHORT_SHA_LENGTH = 7;
const MISSING_AT_REF = /does not exist in|exists on disk, but not in/;

function tryGit(git: GitRunner, args: string[]): string | null {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function hasCommit(git: GitRunner, sha: string): boolean {
  return tryGit(git, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/**
 * On a pull request GitHub checks out a merge commit whose first parent is the base branch tip, so
 * diffing against that parent shows exactly what merging the PR changes. A depth-1 checkout has the
 * parent's SHA but not the commit, so it is fetched.
 */
function pullRequestBase(git: GitRunner, pullRequest: NonNullable<ChangeBaseOptions['pullRequest']>): ChangeBase | null {
  const head = tryGit(git, ['rev-parse', 'HEAD']);
  if (pullRequest.sha && head !== pullRequest.sha) return null;
  const headObject = tryGit(git, ['cat-file', '-p', 'HEAD']) ?? '';
  const parents = [...headObject.matchAll(/^parent (\S+)$/gm)].map((match) => match[1]);
  if (parents.length < 2) return null;

  const base = parents[0];
  const short = base.slice(0, SHORT_SHA_LENGTH);
  if (!hasCommit(git, base)) {
    tryGit(git, ['fetch', '--no-tags', '--depth=1', 'origin', base]);
    if (!hasCommit(git, base)) return { error: `the base commit ${short} is not in this checkout and could not be fetched` };
  }
  return { ref: base, label: `${pullRequest.baseRef} (${short})` };
}

function resolveBranch(git: GitRunner, branch: string): string | null {
  for (const ref of [branch, `origin/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (tryGit(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}

/** Unlike translate's resolveCompareRef, no fallback to the branch tip: that would blame the PR for the base's later commits. */
function branchBase(git: GitRunner, branches: string[]): ChangeBase {
  for (const branch of branches) {
    const ref = resolveBranch(git, branch);
    if (!ref) continue;
    const mergeBase = tryGit(git, ['merge-base', ref, 'HEAD']);
    if (mergeBase) return { ref: mergeBase, label: ref };
    return { error: `this checkout has no commit in common with ${ref}, likely a shallow clone` };
  }
  return { error: `the base branch ${branches.join(' or ')} was not found` };
}

export function resolveChangeBase(git: GitRunner, options: ChangeBaseOptions): ChangeBase {
  if (tryGit(git, ['rev-parse', '--git-dir']) === null) return { error: 'this is not a git repository' };
  const fromPullRequest = options.pullRequest ? pullRequestBase(git, options.pullRequest) : null;
  if (fromPullRequest && 'ref' in fromPullRequest) return fromPullRequest;
  const fromBranch = branchBase(git, options.baseBranches);
  if ('ref' in fromBranch || !fromPullRequest) return fromBranch;
  return fromPullRequest;
}

export function relativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), path.resolve(filePath)).split(path.sep).join('/');
}

/** Files renamed since `ref`, as a map from the current path to the path at `ref`, both relative to the working directory. */
export function renamesSince(git: GitRunner, ref: string): Map<string, string> {
  const fields = git(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=R', '--relative', ref]).split('\0');
  const renames = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) renames.set(fields[i + 2], fields[i + 1]);
  return renames;
}

/** The file's content at `ref`, or null when it did not exist there. Throws when git itself fails. */
export function readFileAtRef(git: GitRunner, ref: string, filePath: string): string | null {
  try {
    return git(['show', `${ref}:./${relativeToCwd(filePath)}`]);
  } catch (error) {
    const { message, stderr } = error as Error & { stderr?: unknown };
    if (MISSING_AT_REF.test(`${message}\n${String(stderr ?? '')}`)) return null;
    throw error;
  }
}
