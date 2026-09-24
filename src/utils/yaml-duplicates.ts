import { parse, parseDocument, stringify, isMap, isScalar, type Node } from 'yaml';

export interface DuplicateKey {
  key: string;
  values: string[];
}

function display(node: unknown): string {
  return isScalar(node) ? String(node.value) : JSON.stringify((node as Node | null)?.toJSON?.() ?? node);
}

// Rails loads a mapping with a repeated key and keeps the last value; the
// earlier one is dead text. Keys are returned without the locale wrapper.
export function findDuplicateYamlKeys(content: string, locale: string): DuplicateKey[] {
  const values = new Map<string, string[]>();

  const walk = (node: unknown, prefix: string): void => {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
      const key = prefix ? `${prefix}.${name}` : name;
      values.set(key, [...(values.get(key) ?? []), display(pair.value)]);
      walk(pair.value, key);
    }
  };
  walk(parseDocument(content, { uniqueKeys: false }).contents, '');

  const wrapper = `${locale}.`;
  return [...values]
    .filter(([, found]) => found.length > 1)
    .map(([key, found]) => ({ key: key.startsWith(wrapper) ? key.slice(wrapper.length) : key, values: found }));
}

export function dedupeYaml(content: string): string {
  return stringify(parse(content, { uniqueKeys: false }));
}
