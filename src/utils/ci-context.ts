export type Env = Record<string, string | undefined>;

export interface CiContext {
  githubActions: boolean;
  pullRequest: { baseRef: string; sha?: string } | null;
  stepSummaryPath: string | null;
}

export function detectCiContext(env: Env): CiContext {
  const githubActions = env.GITHUB_ACTIONS === 'true';
  const baseRef = env.GITHUB_BASE_REF;
  return {
    githubActions,
    pullRequest: githubActions && baseRef ? { baseRef, ...(env.GITHUB_SHA ? { sha: env.GITHUB_SHA } : {}) } : null,
    stepSummaryPath: env.GITHUB_STEP_SUMMARY || null
  };
}

export function escapeAnnotationData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
