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

describe('custom and underscore locales via knownLocales', () => {
  const knownLocales = ['en', 'ja', 'ja_easy', 'zh_cn'];

  it('extracts a custom locale from the basename when declared in knownLocales', () => {
    expect(extractLocaleFromPath('config/locales/ja_easy.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('extracts an underscore locale from the basename when in knownLocales', () => {
    expect(extractLocaleFromPath('config/locales/zh_cn.yml', undefined, knownLocales)).toBe('zh_cn');
  });

  it('returns the knownLocales spelling when the filename casing differs', () => {
    expect(extractLocaleFromPath('config/locales/JA_EASY.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('extracts a custom locale from a path segment', () => {
    expect(extractLocaleFromPath('locales/ja_easy/messages.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('still throws for non-standard codes NOT in knownLocales', () => {
    expect(() => extractLocaleFromPath('config/locales/xx_unknown.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('extracts a standard locale from the basename when in knownLocales', () => {
    expect(extractLocaleFromPath('config/locales/en.yml', undefined, knownLocales)).toBe('en');
  });

  it('extracts a standard regional locale when knownLocales is empty', () => {
    expect(extractLocaleFromPath('config/locales/fr-CA.yml', undefined, [])).toBe('fr-CA');
  });
});

describe('dotted basename last-segment matching via knownLocales', () => {
  const knownLocales = ['en', 'ja', 'ja_easy', 'zh_cn'];

  it('extracts ja_easy from devise.ja_easy.yml', () => {
    expect(extractLocaleFromPath('config/locales/devise.ja_easy.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('extracts zh_cn from messages.zh_cn.yaml', () => {
    expect(extractLocaleFromPath('config/locales/messages.zh_cn.yaml', undefined, knownLocales)).toBe('zh_cn');
  });

  it('extracts ja_easy from devise.JA_EASY.yml (case-insensitive)', () => {
    expect(extractLocaleFromPath('config/locales/devise.JA_EASY.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('throws when last segment is not a known locale', () => {
    expect(() => extractLocaleFromPath('config/locales/devise.xx_nope.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('extracts en from devise.en.yml (standard code via regex, unaffected by change)', () => {
    expect(extractLocaleFromPath('config/locales/devise.en.yml', undefined, knownLocales)).toBe('en');
  });
});

describe('separator-suffix matching via knownLocales', () => {
  const knownLocales = ['en', 'fr', 'ja', 'ja_easy', 'zh_cn'];

  it('extracts zh_cn from messages_zh_cn.yml', () => {
    expect(extractLocaleFromPath('config/locales/messages_zh_cn.yml', undefined, knownLocales)).toBe('zh_cn');
  });

  it('extracts ja_easy from messages-ja_easy.yml', () => {
    expect(extractLocaleFromPath('config/locales/messages-ja_easy.yml', undefined, knownLocales)).toBe('ja_easy');
  });

  it('extracts ja_easy from django_ja_easy.po', () => {
    expect(extractLocaleFromPath('locale/django_ja_easy.po', undefined, knownLocales)).toBe('ja_easy');
  });

  it('returns the knownLocales spelling when the suffix casing differs', () => {
    expect(extractLocaleFromPath('config/locales/messages_ZH_CN.yml', undefined, knownLocales)).toBe('zh_cn');
  });

  it('prefers a locale path segment over a basename suffix', () => {
    expect(extractLocaleFromPath('locales/fr/messages_zh_cn.yml', undefined, knownLocales)).toBe('fr');
  });

  it('throws when the suffix is not a known locale', () => {
    expect(() => extractLocaleFromPath('config/locales/messages_xx_nope.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });

  it('does not treat a word ending in a locale as a suffix without a separator', () => {
    expect(() => extractLocaleFromPath('config/locales/kitchen.yml', undefined, knownLocales))
      .toThrow(/Could not extract locale from path/);
  });
});

describe('gettext LC_MESSAGES layout', () => {
  const knownLocales = ['en', 'sv', 'da', 'de'];

  it('extracts the locale from the directory above LC_MESSAGES when known', () => {
    expect(extractLocaleFromPath('priv/gettext/sv/LC_MESSAGES/errors.po', undefined, knownLocales)).toBe('sv');
  });

  it('extracts the locale from an umbrella gettext path when known', () => {
    expect(extractLocaleFromPath('apps/myapp_web/priv/gettext/da/LC_MESSAGES/default.po', undefined, knownLocales)).toBe('da');
  });

  it('extracts a gettext locale from the directory structure even when not in knownLocales', () => {
    expect(extractLocaleFromPath('apps/myapp_web/priv/gettext/fr/LC_MESSAGES/errors.po', undefined, knownLocales)).toBe('fr');
  });

  it('extracts a regional gettext locale from the directory structure', () => {
    expect(extractLocaleFromPath('priv/gettext/pt_BR/LC_MESSAGES/default.po', undefined, knownLocales)).toBe('pt_BR');
  });

  it('throws when the gettext locale directory is not a valid locale', () => {
    expect(() => extractLocaleFromPath('priv/gettext/sources/LC_MESSAGES/errors.po', undefined, knownLocales))
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
