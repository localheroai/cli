import { describe, it, expect } from '@jest/globals';
import {
  detectLocalesFromPaths,
  looksLikeGettextSource,
  chooseSourceLocale
} from '../../src/utils/locale-detection.js';

describe('detectLocalesFromPaths', () => {
  it('groups Rails files by the locale in their name', () => {
    const result = detectLocalesFromPaths([
      'config/locales/en.yml',
      'config/locales/sv.yml',
      'config/locales/devise.en.yml',
      'config/locales/app/de.yml'
    ]);

    expect(result.locales).toEqual({
      en: ['config/locales/en.yml', 'config/locales/devise.en.yml'],
      sv: ['config/locales/sv.yml'],
      de: ['config/locales/app/de.yml']
    });
    expect(result.templates).toEqual([]);
    expect(result.unrecognized).toEqual([]);
  });

  it('reads the locale from i18next folders, including regions', () => {
    const result = detectLocalesFromPaths(['public/locales/en/common.json', 'public/locales/pt-BR/common.json']);

    expect(Object.keys(result.locales)).toEqual(['en', 'pt-BR']);
  });

  it('reads gettext catalogs and keeps templates apart', () => {
    const result = detectLocalesFromPaths([
      'locale/sv/LC_MESSAGES/django.po',
      'locale/en/LC_MESSAGES/django.po',
      'locale/django.pot'
    ]);

    expect(Object.keys(result.locales).sort()).toEqual(['en', 'sv']);
    expect(result.templates).toEqual(['locale/django.pot']);
  });

  it('reads script-tagged locale folders such as zh-Hant', () => {
    const result = detectLocalesFromPaths(['public/locales/en/common.json', 'public/locales/zh-Hant/common.json']);

    expect(Object.keys(result.locales)).toEqual(['en', 'zh-Hant']);
  });

  it('reads flat gettext catalogs named after their locale', () => {
    const result = detectLocalesFromPaths(['src/locales/en.po', 'src/locales/sv.po', 'src/locales/messages.po']);

    expect(Object.keys(result.locales).sort()).toEqual(['en', 'sv']);
  });

  it('ignores names that are not a language', () => {
    const result = detectLocalesFromPaths(['app/i18n/ui.json', 'app/i18n/db.yml', 'src/i18n/en.json']);

    expect(Object.keys(result.locales)).toEqual(['en']);
    expect(result.unrecognized).toEqual(['app/i18n/ui.json', 'app/i18n/db.yml']);
  });
});

describe('looksLikeGettextSource', () => {
  const po = (entries: string) => `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n${entries}`;

  it('is true for a catalog whose msgstr are empty or equal to the msgid', () => {
    expect(looksLikeGettextSource(po('msgid "Hej"\nmsgstr ""\n\nmsgid "Spara"\nmsgstr "Spara"\n'))).toBe(true);
  });

  it('accepts plural forms that repeat the msgid_plural', () => {
    const plural = 'msgid "1 file"\nmsgid_plural "%d files"\nmsgstr[0] "1 file"\nmsgstr[1] "%d files"\n';
    expect(looksLikeGettextSource(po(plural))).toBe(true);
  });

  it('is false for a translated catalog', () => {
    expect(looksLikeGettextSource(po('msgid "Hej"\nmsgstr "Hello"\n\nmsgid "Spara"\nmsgstr "Save"\n'))).toBe(false);
  });

  it('is false for a catalog with no entries', () => {
    expect(looksLikeGettextSource(po(''))).toBe(false);
  });
});

describe('chooseSourceLocale', () => {
  const locales = ['en', 'sv', 'de'];
  const keyCounts = { en: 10, sv: 12, de: 9 };

  it('uses the --source option first', () => {
    expect(chooseSourceLocale({ explicit: 'sv', locales, keyCounts, gettextSources: [], hasTemplate: false })).toEqual({ locale: 'sv', reason: 'option' });
  });

  it('uses the one gettext catalog that looks like a source', () => {
    expect(chooseSourceLocale({ locales, keyCounts, gettextSources: ['sv'], hasTemplate: false })).toEqual({ locale: 'sv', reason: 'gettext' });
  });

  it('does not trust the gettext signal when several catalogs look like a source', () => {
    expect(chooseSourceLocale({ locales, keyCounts, gettextSources: ['sv', 'de'], hasTemplate: false })).toEqual({ locale: 'en', reason: 'en' });
  });

  it('treats a .pot template as the source, labelled en, when no catalog looks like one', () => {
    expect(chooseSourceLocale({ locales: ['sv', 'de'], keyCounts, gettextSources: [], hasTemplate: true })).toEqual({ locale: 'en', reason: 'template' });
  });

  it('picks en when present', () => {
    expect(chooseSourceLocale({ locales, keyCounts, gettextSources: [], hasTemplate: false })).toEqual({ locale: 'en', reason: 'en' });
  });

  it('guesses the locale with the most keys otherwise', () => {
    expect(chooseSourceLocale({ locales: ['sv', 'de'], keyCounts, gettextSources: [], hasTemplate: false })).toEqual({ locale: 'sv', reason: 'guessed' });
  });

  it('returns nothing when there are no locales', () => {
    expect(chooseSourceLocale({ locales: [], keyCounts: {}, gettextSources: [], hasTemplate: false })).toBeNull();
  });
});
