const UNSUPPORTED_PATTERN_HINT = 'only exact matches and trailing ".*" wildcards are currently supported. Example: "activerecord.errors.*"';

export function validateIgnoreKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid ignoreKeys: must be an array of strings. Got: ${typeof raw}`
    );
  }

  const result: string[] = [];
  for (const [idx, entry] of (raw as unknown[]).entries()) {
    if (typeof entry !== 'string') {
      throw new Error(
        `Invalid ignoreKeys: all entries must be strings. Got: ${String(entry)} at index ${idx}`
      );
    }
    if (entry.length === 0) {
      throw new Error('Invalid ignoreKeys: patterns must be non-empty.');
    }
    if (entry.startsWith('.')) {
      throw new Error(
        `Invalid ignoreKeys pattern "${entry}": patterns cannot start with a dot.`
      );
    }
    if (entry.includes('**') || entry.includes('{') || entry.includes('}')) {
      throw new Error(
        `Unsupported ignoreKeys pattern "${entry}": ${UNSUPPORTED_PATTERN_HINT}`
      );
    }
    if (entry.includes('*')) {
      if (!entry.endsWith('.*') || entry.slice(0, -2).includes('*')) {
        throw new Error(
          `Unsupported ignoreKeys pattern "${entry}": ${UNSUPPORTED_PATTERN_HINT}`
        );
      }
    }
    if (entry.endsWith('.') && !entry.endsWith('.*')) {
      throw new Error(
        `Invalid ignoreKeys pattern "${entry}": patterns cannot end with a bare dot. Did you mean "${entry}*"?`
      );
    }
    result.push(entry);
  }
  return result;
}

export function createIgnoreMatcher(
  patterns: string[]
): (keyName: string) => boolean {
  if (patterns.length === 0) return () => false;

  const exacts = new Set<string>();
  const prefixes: string[] = [];

  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      prefixes.push(pattern.slice(0, -2) + '.');
    } else {
      exacts.add(pattern);
    }
  }

  return (keyName: string) => {
    if (exacts.has(keyName)) return true;
    return prefixes.some((p) => keyName.startsWith(p));
  };
}

export function filterKeys<V>(
  keys: Record<string, V>,
  matcher: (keyName: string) => boolean
): { kept: Record<string, V>; removed: string[] } {
  const kept: Record<string, V> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(keys)) {
    if (matcher(name)) {
      removed.push(name);
    } else {
      kept[name] = value;
    }
  }
  return { kept, removed };
}

export interface IgnoreSummary {
  totalKeysIgnored: number;
  totalTargetTranslationsIgnored: number;
  targetTranslationsPerLocale: Record<string, number>;
  perPattern: Array<{
    pattern: string;
    count: number;
    example?: string;
  }>;
  zeroMatchPatterns: string[];
}

export interface RemovedKey {
  name: string;
  locale?: string;
}

export function summarizeRemoved(
  removed: RemovedKey[],
  patterns: string[]
): IgnoreSummary {
  const exactPatterns = new Set<string>(
    patterns.filter((p) => !p.endsWith('.*'))
  );
  const prefixPatterns = patterns
    .filter((p) => p.endsWith('.*'))
    .map((p) => ({ pattern: p, prefix: p.slice(0, -2) + '.' }));

  const counts = new Map<string, { count: number; example?: string }>();
  for (const p of patterns) counts.set(p, { count: 0, example: undefined });

  let totalTargetTranslationsIgnored = 0;
  const targetTranslationsPerLocale: Record<string, number> = {};

  for (const entry of removed) {
    let attributed: string | undefined;
    if (exactPatterns.has(entry.name)) {
      attributed = entry.name;
    } else {
      const hit = prefixPatterns.find((pp) => entry.name.startsWith(pp.prefix));
      if (hit) attributed = hit.pattern;
    }
    if (attributed) {
      const slot = counts.get(attributed)!;
      slot.count += 1;
      if (slot.example === undefined) slot.example = entry.name;
    }

    if (entry.locale) {
      totalTargetTranslationsIgnored += 1;
      targetTranslationsPerLocale[entry.locale] =
        (targetTranslationsPerLocale[entry.locale] ?? 0) + 1;
    }
  }

  const perPattern = patterns.map((pattern) => {
    const slot = counts.get(pattern)!;
    return { pattern, count: slot.count, example: slot.example };
  });
  const zeroMatchPatterns = perPattern.filter((p) => p.count === 0).map((p) => p.pattern);
  const totalKeysIgnored = perPattern.reduce((a, p) => a + p.count, 0);

  return {
    totalKeysIgnored,
    totalTargetTranslationsIgnored,
    targetTranslationsPerLocale,
    perPattern,
    zeroMatchPatterns,
  };
}
