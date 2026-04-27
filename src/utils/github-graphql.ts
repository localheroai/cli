/**
 * GitHub GraphQL helpers for creating signed commits.
 *
 * `createCommitOnBranch` is the canonical way to push commits via the GitHub
 * App API and have them automatically signed by GitHub. It accepts a base SHA
 * (`expectedHeadOid`) and atomically rejects the call if the branch has
 * advanced — no orphaned tree/commit objects on retry.
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

export interface BranchHead {
  sha: string;
  parentSha: string | null;
  authorEmail: string | null;
}

/**
 * Fetch the current HEAD of a branch via the REST API. Returns the SHA, the
 * parent SHA (for amend semantics), and the author email (to detect whether
 * the last commit was made by the LocalHero bot).
 */
export async function fetchBranchHead(
  repositoryNameWithOwner: string,
  branchName: string,
  token: string,
  deps: GraphQLDependencies = defaultDeps
): Promise<BranchHead> {
  const refUrl = `https://api.github.com/repos/${repositoryNameWithOwner}/git/ref/heads/${encodeURIComponent(branchName)}`;
  const refResponse = await deps.fetch(refUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'localhero-cli'
    }
  });

  if (!refResponse.ok) {
    throw new GitHubGraphQLError(`Failed to fetch branch head: ${refResponse.status} ${refResponse.statusText}`);
  }

  const refBody = (await refResponse.json()) as { object?: { sha?: string } };
  const sha = refBody.object?.sha;
  if (!sha) {
    throw new GitHubGraphQLError(`Branch ${branchName} has no head SHA`);
  }

  const commitUrl = `https://api.github.com/repos/${repositoryNameWithOwner}/commits/${sha}`;
  const commitResponse = await deps.fetch(commitUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'localhero-cli'
    }
  });

  if (!commitResponse.ok) {
    throw new GitHubGraphQLError(`Failed to fetch commit: ${commitResponse.status} ${commitResponse.statusText}`);
  }

  const commitBody = (await commitResponse.json()) as {
    parents?: Array<{ sha: string }>;
    commit?: { author?: { email?: string } };
  };

  return {
    sha,
    parentSha: commitBody.parents?.[0]?.sha ?? null,
    authorEmail: commitBody.commit?.author?.email ?? null
  };
}
