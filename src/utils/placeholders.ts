/**
 * Alternation order matters: `%%` first so an escaped percent cannot start a directive, and longer
 * forms (`{{name}}`, `%<name>s`) before the shorter ones they contain, or both are miscounted.
 * A `%` right after a digit ("5%discount") is a literal percent sign, not a directive.
 */
const PLACEHOLDER_PATTERN =
  /(%%)|\{\{\s*-?\s*([\w.]+)\s*(?:,[^}]*)?\}\}|%<([\w.]+)>[sdf]|%\{([\w.]+)\}|%\(([\w.]+)\)[sdf]|%(\d+)\$([sdfiugx])|(?<!\d)%([sdfiugx])|\{([\w.]+)\}/g;

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
 * Branch text in `{count, plural, one {# item} ...}` is not a placeholder, but a one-word
 * branch ({He}, {Han}) would read as one, so each complex argument is reduced to `{count}`.
 */
const ICU_COMPLEX_START = /\{\s*([\w.]+)\s*,\s*(plural|select|selectordinal)\s*,/g;
const MAX_ICU_REDUCTIONS = 20;

export function reduceIcuComplexArguments(text: string): string {
  let result = text;
  for (let pass = 0; pass < MAX_ICU_REDUCTIONS; pass++) {
    ICU_COMPLEX_START.lastIndex = 0;
    const match = ICU_COMPLEX_START.exec(result);
    if (!match) break;
    const end = matchingBrace(result, match.index);
    if (end === -1) break;
    result = `${result.slice(0, match.index)}{${match[1]}}${result.slice(end + 1)}`;
  }
  return result;
}

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
    const [full, escaped, i18next, railsTyped, rails, python, , positionalType, printf, icu] = match;
    if (escaped) continue;
    const name = i18next ?? railsTyped ?? rails ?? python ?? positionalType ?? printf ?? icu;
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

/**
 * gettext lets translators reorder arguments ("%s: %s" as "%2$s: %1$s"), so a positional
 * directive compares as a plain printf one of the same conversion type.
 */
function token(placeholder: Placeholder): string {
  if (placeholder.kind === 'positional') return `printf:${placeholder.name}`;
  return `${placeholder.kind}:${placeholder.name}`;
}

export function placeholderMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const placeholder of extractPlaceholders(text)) {
    const key = token(placeholder);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
