export function detectMultiLanguage(
  parsedContent: unknown,
  knownLocales: string[]
): boolean {
  if (!parsedContent || typeof parsedContent !== 'object' || Array.isArray(parsedContent)) {
    return false;
  }
  if (knownLocales.length === 0) {
    return false;
  }
  const keys = Object.keys(parsedContent as Record<string, unknown>);
  if (keys.length < 2) {
    return false;
  }
  const known = new Set(knownLocales);
  return keys.every((k) => known.has(k));
}

const LOCALE_CODE_PATTERN = /^[a-zA-Z]{2}(?:-[a-zA-Z]{2})?$/;

export interface SourceKeyedLocales {
  locales: string[];
  unknown: string[];
}

export function sourceKeyedLocales(
  parsedContent: unknown,
  knownLocales: string[],
  sourceLocale: string | undefined
): SourceKeyedLocales | null {
  if (!sourceLocale || !parsedContent || typeof parsedContent !== 'object' || Array.isArray(parsedContent)) {
    return null;
  }
  const content = parsedContent as Record<string, unknown>;
  const keys = Object.keys(content);
  const known = new Set(knownLocales);
  if (!isPlainObject(content[sourceLocale])) {
    return null;
  }
  if (!keys.every((k) => known.has(k) || LOCALE_CODE_PATTERN.test(k))) {
    return null;
  }
  if (!keys.every((k) => content[k] === null || isPlainObject(content[k]))) {
    return null;
  }
  return {
    locales: keys.filter((k) => known.has(k)),
    unknown: keys.filter((k) => !known.has(k))
  };
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
