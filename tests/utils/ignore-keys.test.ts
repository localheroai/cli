import { describe, it, expect } from '@jest/globals';
import { validateIgnoreKeys } from '../../src/utils/ignore-keys.js';

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
    expect(() => validateIgnoreKeys(['ok', 42 as unknown as string]))
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
