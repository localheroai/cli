import { describe, it, expect } from '@jest/globals';
import { detectMultiLanguage, sourceKeyedLocales } from '../../src/utils/multi-language-detection.js';

describe('detectMultiLanguage', () => {
  const locales = ['en', 'sv', 'nb', 'fi'];

  it('returns true when every top-level key is a known locale and there are at least 2', () => {
    expect(detectMultiLanguage({ en: {}, sv: {}, nb: {}, fi: {} }, locales)).toBe(true);
    expect(detectMultiLanguage({ en: {}, sv: {} }, locales)).toBe(true);
  });

  it('returns false when only one top-level locale key (single-lang wrapped)', () => {
    expect(detectMultiLanguage({ en: { subject: 'hi' } }, locales)).toBe(false);
  });

  it('returns false when any top-level key is not a known locale', () => {
    expect(detectMultiLanguage({ en: {}, sv: {}, users: {} }, locales)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(detectMultiLanguage({}, locales)).toBe(false);
  });

  it('returns false for null/undefined/arrays/scalars', () => {
    expect(detectMultiLanguage(null, locales)).toBe(false);
    expect(detectMultiLanguage(undefined, locales)).toBe(false);
    expect(detectMultiLanguage([], locales)).toBe(false);
    expect(detectMultiLanguage('hello', locales)).toBe(false);
    expect(detectMultiLanguage(42, locales)).toBe(false);
  });

  it('accepts a subset of known locales (no equality requirement)', () => {
    expect(detectMultiLanguage({ en: {}, sv: {}, nb: {} }, locales)).toBe(true);
  });

  it('is case-sensitive — does NOT match uppercase or mismatched-case locale keys', () => {
    expect(detectMultiLanguage({ EN: {}, SV: {} }, locales)).toBe(false);
    expect(detectMultiLanguage({ En: {}, sv: {} }, locales)).toBe(false);
  });

  it('handles regional locale codes like pt-BR exactly', () => {
    expect(detectMultiLanguage({ 'pt-BR': {}, en: {} }, ['pt-BR', 'en'])).toBe(true);
    expect(detectMultiLanguage({ 'pt-br': {}, en: {} }, ['pt-BR', 'en'])).toBe(false);
  });

  it('returns false when knownLocales is empty', () => {
    expect(detectMultiLanguage({ en: {}, sv: {} }, [])).toBe(false);
  });
});

describe('sourceKeyedLocales', () => {
  const locales = ['en', 'sv', 'nb', 'fi'];

  it('accepts a file with only the source locale key', () => {
    expect(sourceKeyedLocales({ en: { subject: 'hi' } }, locales, 'en')).toEqual({ locales: ['en'], unknown: [] });
  });

  it('keeps known locales and reports locale-shaped keys that are not configured', () => {
    expect(sourceKeyedLocales({ en: {}, sv: {}, no: {}, fi: {} }, locales, 'en')).toEqual({
      locales: ['en', 'sv', 'fi'],
      unknown: ['no']
    });
  });

  it('returns null without the source locale key', () => {
    expect(sourceKeyedLocales({ sv: {}, nb: {} }, locales, 'en')).toBeNull();
  });

  it('returns null when a top-level key does not look like a locale code', () => {
    expect(sourceKeyedLocales({ en: {}, users: {} }, locales, 'en')).toBeNull();
  });

  it('returns null when the source value is not an object (a language-names file)', () => {
    expect(sourceKeyedLocales({ en: 'English', sv: 'Svenska', de: 'Deutsch' }, locales, 'en')).toBeNull();
  });

  it('accepts empty target locale blocks', () => {
    expect(sourceKeyedLocales({ en: { title: 'Hi' }, sv: null, no: null }, locales, 'en')).toEqual({
      locales: ['en', 'sv'],
      unknown: ['no']
    });
  });

  it('accepts configured locale codes outside the xx or xx-XX shape', () => {
    expect(sourceKeyedLocales({ en: {}, ja_easy: {}, no: {} }, ['en', 'ja_easy'], 'en')).toEqual({
      locales: ['en', 'ja_easy'],
      unknown: ['no']
    });
  });

  it('returns null for non-objects', () => {
    expect(sourceKeyedLocales(null, locales, 'en')).toBeNull();
    expect(sourceKeyedLocales([], locales, 'en')).toBeNull();
  });
});
