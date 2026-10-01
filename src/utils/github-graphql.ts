/**
 * GitHub API helpers for creating signed commits.
 *
 * `createCommitOnBranch` is the canonical way to push commits via the GitHub
 * App API and have them automatically signed by GitHub. It accepts a base SHA
 * (`expectedHeadOid`) and atomically rejects the call if the branch has
 * advanced, without leaving orphaned tree/commit objects.
 *
 * Reference: https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
 */

export interface FileAddition {
  /** Repo-relative path */
  path: string;
  /** Base64-encoded contents */
  contents: string;
}

export interface FileDeletion {
  path: string;
}

export interface CreateCommitInput {
  repositoryNameWithOwner: string;
  branchName: string;
  expectedHeadOid: string;
  message: { headline: string; body?: string };
  fileChanges: {
    additions?: FileAddition[];
    deletions?: FileDeletion[];
  };
  token: string;
}

export interface CreateCommitResult {
  commitSha: string;
  commitUrl: string;
}

export class GitHubGraphQLError extends Error {
  constructor(message: string, public readonly type?: string, public readonly errors?: unknown) {
    super(message);
    this.name = 'GitHubGraphQLError';
  }
}

export class StaleHeadError extends GitHubGraphQLError {
  constructor(message: string) {
    super(message, 'STALE_DATA');
    this.name = 'StaleHeadError';
  }
}

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const REST_API_BASE = 'https://api.github.com';
// GitHub lists at most 300 changed files per comparison, so a full list may be cut short.
export const COMPARE_FILES_CAP = 300;

export interface GraphQLDependencies {
  fetch: typeof fetch;
}

const defaultDeps: GraphQLDependencies = {
  fetch: globalThis.fetch.bind(globalThis)
};

const CREATE_COMMIT_MUTATION = `
mutation CreateSignedCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}`;

export async function createSignedCommit(
  input: CreateCommitInput,
  deps: GraphQLDependencies = defaultDeps
): Promise<CreateCommitResult> {
  const variables = {
    input: {
      branch: {
        repositoryNameWithOwner: input.repositoryNameWithOwner,
        branchName: input.branchName
      },
      message: input.message,
      expectedHeadOid: input.expectedHeadOid,
      fileChanges: input.fileChanges
    }
  };

  const response = await deps.fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'localhero-cli'
    },
    body: JSON.stringify({ query: CREATE_COMMIT_MUTATION, variables })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new GitHubGraphQLError(
      `GitHub GraphQL request failed: ${response.status} ${response.statusText} — ${text}`
    );
  }

  let payload: { data?: { createCommitOnBranch?: { commit?: { oid: string; url: string } } }; errors?: Array<{ message: string; type?: string }> };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GitHubGraphQLError(`GitHub GraphQL returned non-JSON response: ${text}`);
  }

  if (payload.errors && payload.errors.length > 0) {
    const stale = payload.errors.find(e => e.type === 'STALE_DATA');
    if (stale) {
      throw new StaleHeadError(stale.message);
    }
    const first = payload.errors[0];
    throw new GitHubGraphQLError(first.message, first.type, payload.errors);
  }

  const commit = payload.data?.createCommitOnBranch?.commit;
  if (!commit) {
    throw new GitHubGraphQLError(`GitHub GraphQL returned no commit data: ${text}`);
  }

  return { commitSha: commit.oid, commitUrl: commit.url };
}

async function getRestJson<T>(url: string, token: string, deps: GraphQLDependencies): Promise<T> {
  const response = await deps.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'localhero-cli'
    }
  });

  if (!response.ok) {
    throw new GitHubGraphQLError(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function fetchBranchHead(
  repositoryNameWithOwner: string,
  branchName: string,
  token: string,
  deps: GraphQLDependencies = defaultDeps
): Promise<string> {
  const encodedBranch = branchName.split('/').map(encodeURIComponent).join('/');
  const body = await getRestJson<{ object?: { sha?: string } }>(
    `${REST_API_BASE}/repos/${repositoryNameWithOwner}/git/ref/heads/${encodedBranch}`,
    token,
    deps
  );

  const sha = body.object?.sha;
  if (!sha) {
    throw new GitHubGraphQLError(`Branch ${branchName} has no head SHA`);
  }
  return sha;
}

interface CompareResponse {
  status?: string;
  total_commits?: number;
  commits?: unknown[];
  files?: Array<{ filename: string; previous_filename?: string }>;
}

/**
 * Paths changed between `base` and `head`, where `head` descends from `base`.
 * Renames report both the old and the new path. Returns null when GitHub can't
 * give a complete answer: `head` is not strictly ahead (force-push, divergence),
 * or the files or commits list was cut short.
 */
export async function fetchChangedPaths(
  repositoryNameWithOwner: string,
  base: string,
  head: string,
  token: string,
  deps: GraphQLDependencies = defaultDeps
): Promise<string[] | null> {
  const body = await getRestJson<CompareResponse>(
    `${REST_API_BASE}/repos/${repositoryNameWithOwner}/compare/${base}...${head}`,
    token,
    deps
  );

  const { status, total_commits: totalCommits, commits, files } = body;
  if (status !== 'ahead' || !Array.isArray(files) || !Array.isArray(commits)) return null;
  if (files.length >= COMPARE_FILES_CAP || totalCommits !== commits.length) return null;

  return files.flatMap(file => [file.filename, file.previous_filename].filter((p): p is string => Boolean(p)));
}
