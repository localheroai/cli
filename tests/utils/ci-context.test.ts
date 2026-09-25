import { describe, it, expect } from '@jest/globals';
import { detectCiContext } from '../../src/utils/ci-context.js';

describe('detectCiContext', () => {
  it('sees a GitHub pull request run', () => {
    expect(
      detectCiContext({ GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main', GITHUB_SHA: 'abc', GITHUB_STEP_SUMMARY: '/tmp/summary' })
    ).toEqual({ githubActions: true, pullRequest: { baseRef: 'main', sha: 'abc' }, stepSummaryPath: '/tmp/summary' });
  });

  it('sees a GitHub run outside a pull request, where the base ref is empty', () => {
    expect(detectCiContext({ GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: '' })).toEqual({
      githubActions: true,
      pullRequest: null,
      stepSummaryPath: null
    });
  });

  it('does not treat a base ref outside GitHub Actions as a pull request', () => {
    expect(detectCiContext({ GITHUB_BASE_REF: 'main' })).toEqual({ githubActions: false, pullRequest: null, stepSummaryPath: null });
  });
});
