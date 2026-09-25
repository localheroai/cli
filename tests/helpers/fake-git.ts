export interface FakeRepo {
  isRepo?: boolean;
  head?: string;
  headParents?: string[];
  /** Commits present in the object store. */
  commits?: Set<string>;
  /** Commits `git fetch origin <sha>` can bring in. */
  fetchable?: Set<string>;
  /** Branch refs (as `rev-parse --verify` accepts them) mapped to their commit. */
  refs?: Record<string, string>;
  /** Merge-base of a commit with HEAD; missing means none. */
  mergeBases?: Record<string, string>;
  /** File contents per commit and path relative to the working directory. */
  files?: Record<string, Record<string, string>>;
  /** Files renamed since the base: new path mapped to old path. */
  renames?: Record<string, string>;
}

export interface FakeGit {
  (args: string[]): string;
  calls: string[][];
}

function fail(message: string): never {
  throw Object.assign(new Error(`Command failed: git\n${message}`), { stderr: message });
}

export function fakeGit(repo: FakeRepo): FakeGit {
  const commits = new Set(repo.commits ?? []);
  const calls: string[][] = [];
  const git = ((args: string[]) => {
    calls.push(args);
    if (repo.isRepo === false) fail('fatal: not a git repository');
    const [command, ...rest] = args;
    if (command === 'rev-parse' && rest[0] === '--git-dir') return '.git\n';
    if (command === 'rev-parse' && rest[0] === 'HEAD') return `${repo.head ?? 'head'}\n`;
    if (command === 'rev-parse' && rest[0] === '--verify') {
      const ref = rest[rest.length - 1].replace('^{commit}', '');
      if (repo.refs?.[ref]) return `${repo.refs[ref]}\n`;
      fail('');
    }
    if (command === 'cat-file' && rest[0] === '-p' && rest[1] === 'HEAD') {
      return ['tree t', ...(repo.headParents ?? []).map((p) => `parent ${p}`), 'author a', ''].join('\n');
    }
    if (command === 'cat-file' && rest[0] === '-e') {
      const sha = rest[1].replace('^{commit}', '');
      if (commits.has(sha)) return '';
      fail(`fatal: Not a valid object name ${rest[1]}`);
    }
    if (command === 'fetch') {
      const sha = rest[rest.length - 1];
      if (repo.fetchable?.has(sha)) {
        commits.add(sha);
        return '';
      }
      fail(`fatal: remote error: upload-pack: not our ref ${sha}`);
    }
    if (command === 'merge-base') {
      const base = repo.mergeBases?.[rest[0]];
      if (base) return `${base}\n`;
      fail('');
    }
    if (command === 'diff') {
      return Object.entries(repo.renames ?? {}).map(([to, from]) => `R100\0${from}\0${to}\0`).join('');
    }
    if (command === 'show') {
      const [ref, filePath] = rest[0].split(':./');
      const content = repo.files?.[ref]?.[filePath];
      if (content !== undefined) return content;
      if (!repo.files?.[ref]) fail(`fatal: invalid object name '${ref}'.`);
      fail(`fatal: path '${filePath}' does not exist in '${ref}'`);
    }
    fail(`unexpected git ${args.join(' ')}`);
  }) as FakeGit;
  git.calls = calls;
  return git;
}
