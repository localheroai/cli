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
