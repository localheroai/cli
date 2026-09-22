/**
 * Extracts interpolation placeholders from a translation string so two
 * strings can be compared for structural equivalence, independent of the
 * words around them.
 *
 * Order in the alternation matters: `{{name}}` must be tried before
 * `{name}`, and `%<name>s` before a bare `%s`, or the shorter pattern would
 * eat part of the longer one and silently miscount both.
 */
const PLACEHOLDER_PATTERN =
  /\{\{\s*([\w.]+)\s*\}\}|%<([\w.]+)>[sdf]|%\{([\w.]+)\}|%\(([\w.]+)\)[sdf]|%(\d+)\$[sdf]|%([sdf])(?![\w%])|\{([\w.]+)\}/g;

export type PlaceholderKind =
  | 'i18next' // {{name}}
  | 'icu' // {name}
  | 'rails-typed' // %<name>s
  | 'rails' // %{name}
  | 'python' // %(name)s
  | 'positional' // %1$s
  | 'printf'; // %s %d %f

export interface Placeholder {
  kind: PlaceholderKind;
  name: string;
}

/**
 * ICU complex arguments such as `{count, plural, one {# item} other {# items}}`
 * contain literal branch text that is not a placeholder. Left alone, a branch
 * value of a single word ({He}, {Han}) is read as an ICU placeholder and two
 * correct translations are reported as a mismatch. Reduce each complex
 * argument to its bare argument name before extraction, so only `{count}`
 * remains and the translated branch text is ignored.
 */
const ICU_COMPLEX_START = /\{\s*([\w.]+)\s*,\s*(plural|select|selectordinal)\s*,/g;

export function reduceIcuComplexArguments(text: string): string {
  let result = text;
  let guard = 0;
  while (guard++ < 20) {
    ICU_COMPLEX_START.lastIndex = 0;
    const match = ICU_COMPLEX_START.exec(result);
    if (!match) break;
    const end = matchingBrace(result, match.index);
    if (end === -1) break;
    result = `${result.slice(0, match.index)}{${match[1]}}${result.slice(end + 1)}`;
  }
  return result;
}

/** Index of the `}` closing the `{` at `start`, or -1 if unbalanced. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

export function extractPlaceholders(text: string): Placeholder[] {
  if (typeof text !== 'string') return [];
  const found: Placeholder[] = [];
  for (const match of reduceIcuComplexArguments(text).matchAll(PLACEHOLDER_PATTERN)) {
    const [full, i18next, railsTyped, rails, python, positional, printf, icu] = match;
    const name = i18next ?? railsTyped ?? rails ?? python ?? positional ?? printf ?? icu;
    found.push({ kind: classify(full), name });
  }
  return found;
}

function classify(full: string): PlaceholderKind {
  if (full.startsWith('{{')) return 'i18next';
  if (full.startsWith('{')) return 'icu';
  if (full.startsWith('%<')) return 'rails-typed';
  if (full.startsWith('%{')) return 'rails';
  if (full.startsWith('%(')) return 'python';
  if (/^%\d/.test(full)) return 'positional';
  return 'printf';
}

function token(placeholder: Placeholder): string {
  return `${placeholder.kind}:${placeholder.name}`;
}

/** Multiset of placeholder tokens, keyed by "kind:name" -> count. */
export function placeholderMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const placeholder of extractPlaceholders(text)) {
    const key = token(placeholder);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
