import { describe, it, expect } from '@jest/globals';
import { validateIgnoreKeys, createIgnoreMatcher } from '../../src/utils/ignore-keys.js';

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
