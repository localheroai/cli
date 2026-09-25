import path from 'path';
import { extractLocaleFromPath } from './files.js';
import { parsePoFile } from './po-utils.js';

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const GETTEXT_SOURCE_SHARE = 0.9;

export interface DetectedLocales {
  locales: Record<string, string[]>;
  templates: string[];
  unrecognized: string[];
}

export type SourceReason = 'option' | 'gettext' | 'template' | 'en' | 'guessed';

export interface SourceChoice {
  locale: string;
  reason: SourceReason;
}

// "ui.json" or "db.yml" match the locale pattern but name no language.
function isLanguage(code: string): boolean {
  try {
    return LANGUAGE_NAMES.of(code.replace('_', '-')) !== undefined;
  } catch {
    return false;
  }
}

// The default locale pattern misses flat gettext names (sv.po) and script
// tags (zh-Hant), so the folder and file names are tried as languages too.
function localeOf(filePath: string): string | null {
  const candidates = [path.basename(path.dirname(filePath)), path.basename(filePath, path.extname(filePath))];
  try {
    candidates.unshift(extractLocaleFromPath(filePath));
  } catch {
    // no locale in the conventional places
  }
  return candidates.find(isLanguage) ?? null;
}

export function detectLocalesFromPaths(filePaths: string[]): DetectedLocales {
  const locales: Record<string, string[]> = {};
  const templates: string[] = [];
  const unrecognized: string[] = [];

  for (const filePath of filePaths) {
    if (path.extname(filePath) === '.pot') {
      templates.push(filePath);
      continue;
    }
    const locale = localeOf(filePath);
    if (!locale) {
      unrecognized.push(filePath);
      continue;
    }
    (locales[locale] ??= []).push(filePath);
  }

  return { locales, templates, unrecognized };
}

// A gettext source catalog leaves msgstr empty or repeats the msgid.
export function looksLikeGettextSource(content: string): boolean {
  const { entries } = parsePoFile(content);
  if (entries.length === 0) return false;
  const untranslated = entries.filter((entry) =>
    entry.msgstr.every((value) => value === '' || value === entry.msgid || value === entry.msgid_plural)
  );
  return untranslated.length / entries.length >= GETTEXT_SOURCE_SHARE;
}

export function chooseSourceLocale(input: {
  explicit?: string;
  locales: string[];
  keyCounts: Record<string, number>;
  gettextSources: string[];
  hasTemplate: boolean;
}): SourceChoice | null {
  const { explicit, locales, keyCounts, gettextSources, hasTemplate } = input;
  if (explicit) return { locale: explicit, reason: 'option' };
  if (gettextSources.length === 1) return { locale: gettextSources[0], reason: 'gettext' };
  if (hasTemplate) return { locale: 'en', reason: 'template' };
  if (locales.length === 0) return null;
  if (locales.includes('en')) return { locale: 'en', reason: 'en' };

  const [mostKeys] = [...locales].sort((a, b) => (keyCounts[b] ?? 0) - (keyCounts[a] ?? 0));
  return { locale: mostKeys, reason: 'guessed' };
}
