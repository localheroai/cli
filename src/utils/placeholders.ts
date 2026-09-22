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

export function extractPlaceholders(text: string): Placeholder[] {
  if (typeof text !== 'string') return [];
  const found: Placeholder[] = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const [full, i18next, icu, railsTyped, railsGeneric, python, positional, printf] = match;
    found.push({ kind: classify(full), name: i18next ?? icu ?? railsTyped ?? railsGeneric ?? python ?? positional ?? printf });
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
