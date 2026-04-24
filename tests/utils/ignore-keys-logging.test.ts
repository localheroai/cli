import { describe, it, expect } from '@jest/globals';
import { logIgnoreSummary } from '../../src/utils/ignore-keys-logging.js';
import type { IgnoreSummary } from '../../src/utils/ignore-keys.js';

function makeLogger() {
  const logs: string[] = [];
  return {
    logger: { log: (msg: unknown) => logs.push(String(msg)) },
    logs,
  };
}

describe('logIgnoreSummary', () => {
  it('emits nothing when the summary has no content', () => {
    const summary: IgnoreSummary = {
      totalKeysIgnored: 0,
      totalTargetTranslationsIgnored: 0,
      targetTranslationsPerLocale: {},
      perPattern: [],
      zeroMatchPatterns: [],
    };
    const { logger, logs } = makeLogger();
    logIgnoreSummary(summary, logger);
    expect(logs).toEqual([]);
  });

  it('emits the main summary line and per-pattern breakdown when keys were ignored', () => {
    const summary: IgnoreSummary = {
      totalKeysIgnored: 3,
      totalTargetTranslationsIgnored: 0,
      targetTranslationsPerLocale: {},
      perPattern: [
        { pattern: 'activerecord.errors.*', count: 2, example: 'activerecord.errors.foo' },
        { pattern: 'pundit.*', count: 1, example: 'pundit.not_authorized' },
      ],
      zeroMatchPatterns: [],
    };
    const { logger, logs } = makeLogger();
    logIgnoreSummary(summary, logger);
    const joined = logs.join('\n');
    expect(joined).toContain('Ignored 3 keys matching ignoreKeys patterns');
    expect(joined).toContain('activerecord.errors.* → 2 keys (e.g., activerecord.errors.foo)');
    expect(joined).toContain('pundit.* → 1 keys (e.g., pundit.not_authorized)');
  });

  it('skips patterns with zero count in the per-pattern output', () => {
    const summary: IgnoreSummary = {
      totalKeysIgnored: 1,
      totalTargetTranslationsIgnored: 0,
      targetTranslationsPerLocale: {},
      perPattern: [
        { pattern: 'foo.*', count: 1, example: 'foo.bar' },
        { pattern: 'unused.*', count: 0, example: undefined },
      ],
      zeroMatchPatterns: ['unused.*'],
    };
    const { logger, logs } = makeLogger();
    logIgnoreSummary(summary, logger);
    const joined = logs.join('\n');
    expect(joined).toContain('foo.* → 1 keys');
    expect(joined).not.toContain('unused.* → 0 keys');
  });

  it('emits the per-locale line when target translations were filtered', () => {
    const summary: IgnoreSummary = {
      totalKeysIgnored: 3,
      totalTargetTranslationsIgnored: 4,
      targetTranslationsPerLocale: { sv: 3, nb: 1 },
      perPattern: [{ pattern: 'foo.*', count: 3, example: 'foo.bar' }],
      zeroMatchPatterns: [],
    };
    const { logger, logs } = makeLogger();
    logIgnoreSummary(summary, logger);
    const joined = logs.join('\n');
    expect(joined).toContain('4 target translations for ignored keys were also filtered');
    expect(joined).toContain('sv: 3');
    expect(joined).toContain('nb: 1');
  });

  it('emits a stale warning for each zero-match pattern', () => {
    const summary: IgnoreSummary = {
      totalKeysIgnored: 0,
      totalTargetTranslationsIgnored: 0,
      targetTranslationsPerLocale: {},
      perPattern: [
        { pattern: 'stale.one.*', count: 0, example: undefined },
        { pattern: 'stale.two', count: 0, example: undefined },
      ],
      zeroMatchPatterns: ['stale.one.*', 'stale.two'],
    };
    const { logger, logs } = makeLogger();
    logIgnoreSummary(summary, logger);
    const joined = logs.join('\n');
    expect(joined).toContain('Pattern "stale.one.*" in ignoreKeys matched no keys');
    expect(joined).toContain('Pattern "stale.two" in ignoreKeys matched no keys');
  });
});
