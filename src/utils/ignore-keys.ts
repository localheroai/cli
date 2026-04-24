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
