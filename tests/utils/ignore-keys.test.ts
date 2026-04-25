import { describe, it, expect } from '@jest/globals';
import { validateIgnoreKeys, createIgnoreMatcher, filterKeys, summarizeRemoved } from '../../src/utils/ignore-keys.js';

describe('validateIgnoreKeys', () => {
  it('returns [] when input is undefined', () => {
    expect(validateIgnoreKeys(undefined)).toEqual([]);
  });

  it('returns [] when input is null', () => {
    expect(validateIgnoreKeys(null)).toEqual([]);
  });

  it('returns the array when all entries are valid exact or prefix patterns', () => {
    const input = ['activerecord.errors.*', 'pundit.not_authorized'];
    expect(validateIgnoreKeys(input)).toEqual(input);
  });

  it('throws when input is not an array', () => {
    expect(() => validateIgnoreKeys('foo')).toThrow(/must be an array of strings/);
  });

  it('throws when an entry is not a string', () => {
    expect(() => validateIgnoreKeys(['ok', 42]))
      .toThrow(/all entries must be strings.*at index 1/);
  });

  it('throws on empty string', () => {
    expect(() => validateIgnoreKeys([''])).toThrow(/must be non-empty/);
  });

  it('throws on leading dot', () => {
    expect(() => validateIgnoreKeys(['.foo.bar'])).toThrow(/cannot start with a dot/);
  });

  it('throws on mid-string wildcard', () => {
    expect(() => validateIgnoreKeys(['foo.*.bar'])).toThrow(/only exact matches and trailing ".\*"/);
  });

  it('throws on double-star', () => {
    expect(() => validateIgnoreKeys(['foo.**'])).toThrow(/only exact matches and trailing ".\*"/);
  });

  it('throws on brace expansion', () => {
    expect(() => validateIgnoreKeys(['{a,b}.foo'])).toThrow(/only exact matches and trailing ".\*"/);
  });

  it('throws on bare trailing dot', () => {
    expect(() => validateIgnoreKeys(['foo.bar.'])).toThrow(/cannot end with a bare dot.*foo\.bar\.\*/);
  });
});

describe('createIgnoreMatcher', () => {
  it('returns always-false when patterns is empty', () => {
    const match = createIgnoreMatcher([]);
    expect(match('foo')).toBe(false);
    expect(match('foo.bar')).toBe(false);
  });

  it('matches exact patterns as literal keys', () => {
    const match = createIgnoreMatcher(['activerecord.errors.messages.record_invalid']);
    expect(match('activerecord.errors.messages.record_invalid')).toBe(true);
    expect(match('activerecord.errors.messages.record_invalid.extra')).toBe(false);
    expect(match('activerecord.errors.messages')).toBe(false);
  });

  it('matches trailing-wildcard patterns at any depth beyond the prefix', () => {
    const match = createIgnoreMatcher(['activerecord.errors.*']);
    expect(match('activerecord.errors.foo')).toBe(true);
    expect(match('activerecord.errors.deep.nested.leaf')).toBe(true);
  });

  it('does NOT match the bare prefix of a trailing-wildcard pattern', () => {
    const match = createIgnoreMatcher(['activerecord.errors.*']);
    expect(match('activerecord.errors')).toBe(false);
    expect(match('activerecord')).toBe(false);
  });

  it('composes multiple patterns', () => {
    const match = createIgnoreMatcher(['activerecord.errors.*', 'pundit.*']);
    expect(match('activerecord.errors.foo')).toBe(true);
    expect(match('pundit.not_authorized')).toBe(true);
    expect(match('navigation.home')).toBe(false);
  });
});

describe('filterKeys', () => {
  it('returns full kept map and empty removed when matcher is always-false', () => {
    const matcher = (_: string) => false;
    const input = { 'a.b': 1, 'c.d': 2 };
    const result = filterKeys(input, matcher);
    expect(result.kept).toEqual(input);
    expect(result.removed).toEqual([]);
    expect(result.kept).not.toBe(input);
  });

  it('removes matching keys and records their names', () => {
    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const input = {
      'navigation.home': 'Home',
      'activerecord.errors.messages.foo': 'bar',
      'activerecord.errors.models.user.email.blank': 'blank',
    };
    const result = filterKeys(input, matcher);
    expect(result.kept).toEqual({ 'navigation.home': 'Home' });
    expect(result.removed).toEqual([
      'activerecord.errors.messages.foo',
      'activerecord.errors.models.user.email.blank',
    ]);
  });

  it('does not mutate input', () => {
    const matcher = createIgnoreMatcher(['foo.*']);
    const input = { 'foo.bar': 1, 'baz': 2 };
    const snapshot = JSON.stringify(input);
    filterKeys(input, matcher);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles empty input', () => {
    const result = filterKeys({}, createIgnoreMatcher(['foo.*']));
    expect(result.kept).toEqual({});
    expect(result.removed).toEqual([]);
  });
});

describe('summarizeRemoved', () => {
  it('returns zero summary when removed is empty, listing all patterns as stale', () => {
    const summary = summarizeRemoved([], ['activerecord.errors.*', 'pundit.*']);
    expect(summary.totalKeysIgnored).toBe(0);
    expect(summary.totalTargetTranslationsIgnored).toBe(0);
    expect(summary.targetTranslationsPerLocale).toEqual({});
    expect(summary.perPattern.map((p) => p.pattern)).toEqual([
      'activerecord.errors.*',
      'pundit.*',
    ]);
    expect(summary.perPattern.every((p) => p.count === 0)).toBe(true);
    expect(summary.zeroMatchPatterns).toEqual(['activerecord.errors.*', 'pundit.*']);
  });

  it('attributes counts and examples to the correct pattern', () => {
    const summary = summarizeRemoved(
      [
        { name: 'activerecord.errors.foo' },
        { name: 'activerecord.errors.bar.baz' },
        { name: 'pundit.not_authorized' },
      ],
      ['activerecord.errors.*', 'pundit.*']
    );
    const byPattern = Object.fromEntries(summary.perPattern.map((p) => [p.pattern, p]));
    expect(byPattern['activerecord.errors.*'].count).toBe(2);
    expect(byPattern['activerecord.errors.*'].example).toBe('activerecord.errors.foo');
    expect(byPattern['pundit.*'].count).toBe(1);
    expect(byPattern['pundit.*'].example).toBe('pundit.not_authorized');
    expect(summary.totalKeysIgnored).toBe(3);
    expect(summary.zeroMatchPatterns).toEqual([]);
  });

  it('exact patterns win over prefix patterns', () => {
    const summary = summarizeRemoved(
      [{ name: 'admin.debug' }, { name: 'admin.debug.verbose' }],
      ['admin.debug', 'admin.debug.*']
    );
    const byPattern = Object.fromEntries(summary.perPattern.map((p) => [p.pattern, p]));
    expect(byPattern['admin.debug'].count).toBe(1);
    expect(byPattern['admin.debug.*'].count).toBe(1);
  });

  it('tallies target translations per locale when locale is present', () => {
    const summary = summarizeRemoved(
      [
        { name: 'activerecord.errors.foo', locale: 'sv' },
        { name: 'activerecord.errors.bar', locale: 'nb' },
        { name: 'activerecord.errors.baz', locale: 'sv' },
        { name: 'activerecord.errors.qux' },
      ],
      ['activerecord.errors.*']
    );
    expect(summary.totalTargetTranslationsIgnored).toBe(3);
    expect(summary.targetTranslationsPerLocale).toEqual({ sv: 2, nb: 1 });
  });
});
