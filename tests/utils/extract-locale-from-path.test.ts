import { describe, it, expect } from '@jest/globals';
import { extractLocaleFromPath } from '../../src/utils/files.js';

describe('extractLocaleFromPath', () => {
  const knownLocales = ['en', 'sv', 'nb', 'fi'];
  const regionalKnownLocales = ['en', 'sv', 'pt-BR', 'en-US', 'en-us'];

  it('extracts locale from simple basename', () => {
    expect(extractLocaleFromPath('config/locales/en.yml', undefined, knownLocales)).toBe('en');
  });

  it('extracts regional locale from basename (preserves case)', () => {
    expect(extractLocaleFromPath('locales/pt-BR.yml', undefined, regionalKnownLocales)).toBe('pt-BR');
  });

  it('extracts lowercase regional locale from basename', () => {
    expect(extractLocaleFromPath('locales/en-us.yml', undefined, regionalKnownLocales)).toBe('en-us');
  });

  it('extracts locale from dotted filename', () => {
    expect(extractLocaleFromPath('config/locales/csv_export.en.yml', undefined, knownLocales)).toBe('en');
  });

  it('extracts regional locale from dotted filename', () => {
    expect(extractLocaleFromPath('messages.pt-BR.yml', undefined, regionalKnownLocales)).toBe('pt-BR');
  });

  it('extracts locale from underscore-separated filename', () => {
    expect(extractLocaleFromPath('translations_en.yml', undefined, knownLocales)).toBe('en');
  });

  it('extracts locale from dash-separated filename', () => {
    expect(extractLocaleFromPath('translations-en.yml', undefined, knownLocales)).toBe('en');
  });

  it('extracts locale from path segment', () => {
    expect(extractLocaleFromPath('locales/en/common.yml', undefined, knownLocales)).toBe('en');
  });
});

describe('extractLocaleFromPath — regression guards', () => {
  const knownLocales = ['en', 'sv', 'nb', 'fi'];

  it('throws on non-locale YAML with 2-letter suffix (mailer.yml → not "er")', () => {
    expect(() => extractLocaleFromPath('apps/messaging/config/mailer.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('throws on config.yml (would greedy-match "ig")', () => {
    expect(() => extractLocaleFromPath('some/path/config.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('throws on welcome.i18n.yml (no locale suffix at all)', () => {
    expect(() => extractLocaleFromPath('apps/views/welcome.i18n.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('throws on database.yml (would greedy-match "se")', () => {
    expect(() => extractLocaleFromPath('config/database.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('throws when captured locale is NOT in knownLocales', () => {
    // foo.da.yml looks locale-shaped, but "da" isn't configured — should throw
    expect(() => extractLocaleFromPath('foo.da.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });
});

describe('extractLocaleFromPath — knownLocales empty', () => {
  it('returns any valid-looking locale when knownLocales is not provided', () => {
    expect(extractLocaleFromPath('foo.en.yml', undefined, [])).toBe('en');
  });

  it('still applies the separator-guard even when knownLocales is empty', () => {
    // mailer.yml should throw even without a knownLocales list — separator guard does the work
    expect(() => extractLocaleFromPath('apps/messaging/config/mailer.yml', undefined, []))
      .toThrow(/Could not extract locale from path/);
  });
});

describe('extractLocaleFromPath — custom regex', () => {
  it('returns captured locale when user-supplied custom regex matches, even if not in knownLocales', () => {
    // When the caller provides their own regex, we trust it — useful for
    // discovering all locale files (e.g. allFiles includes unconfigured locales).
    // The separator guard only applies to the default regex.
    const customRegex = '(?:^|[._-])([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$';
    expect(extractLocaleFromPath('messages.de.yml', customRegex, ['en', 'sv'])).toBe('de');
  });

  it('default regex rejects mailer.yml even without knownLocales — separator guard is sufficient', () => {
    // Change 1 (separator guard in DEFAULT_LOCALE_REGEX) is the primary protection.
    // "er" in "mailer" has no separator before it, so the regex never matches.
    expect(() => extractLocaleFromPath('mailer.yml', undefined, []))
      .toThrow(/Could not extract locale from path/);
  });
});
