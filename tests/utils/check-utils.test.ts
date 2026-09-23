import { describe, it, expect } from '@jest/globals';
import {
  findOrphanKeys,
  findPlaceholderMismatches,
  findStructureMismatches,
  findPluralShapeMismatches,
  findEmptyAndIdentical,
  findMissingPluralCategories,
  findConflictingKeys
} from '../../src/utils/check-utils.js';

describe('findOrphanKeys', () => {
  it('finds target keys with no matching source key', () => {
    const source = { greeting: 'Hi' };
    const target = { greeting: 'Hej', old_key: 'Gammal' };
    expect(findOrphanKeys(source, target)).toEqual([{ key: 'old_key', target: 'Gammal' }]);
  });

  it('finds nothing when every target key exists in source', () => {
    const source = { greeting: 'Hi' };
    const target = { greeting: 'Hej' };
    expect(findOrphanKeys(source, target)).toEqual([]);
  });
});

describe('findPlaceholderMismatches', () => {
  it('flags a placeholder missing from the target', () => {
    const source = { welcome: 'Hi %{name}' };
    const target = { welcome: 'Hej' };
    const found = findPlaceholderMismatches(source, target);
    expect(found).toHaveLength(1);
    expect(found[0].missingInTarget).toEqual(['rails:name']);
  });

  it('flags a placeholder the target added that the source does not have', () => {
    const source = { welcome: 'Hi' };
    const target = { welcome: 'Hej %{name}' };
    const found = findPlaceholderMismatches(source, target);
    expect(found[0].unexpectedInTarget).toEqual(['rails:name']);
  });

  it('does not flag {{name}} vs {{name}} as mismatched with {name}', () => {
    const source = { welcome: 'Hi {{name}}' };
    const target = { welcome: 'Hej {{name}}' };
    expect(findPlaceholderMismatches(source, target)).toEqual([]);
  });

  it('does not flag a literal percent sign', () => {
    const source = { discount: 'Save 10% today' };
    const target = { discount: 'Spara 10% idag' };
    expect(findPlaceholderMismatches(source, target)).toEqual([]);
  });

  it('skips keys with no target value (that is a missing-key finding, not a placeholder one)', () => {
    const source = { welcome: 'Hi %{name}' };
    const target = {};
    expect(findPlaceholderMismatches(source, target)).toEqual([]);
  });

  it('passes when both sides use the same placeholder', () => {
    const source = { welcome: 'Hi %{name}' };
    const target = { welcome: 'Hej %{name}' };
    expect(findPlaceholderMismatches(source, target)).toEqual([]);
  });
});

describe('findStructureMismatches', () => {
  it('flags a string source with a map target', () => {
    const source = { title: 'Hello' };
    const target = { title: { nested: 'Hej' } };
    expect(findStructureMismatches(source, target)).toEqual([
      { key: 'title', sourceShape: 'string', targetShape: 'map' }
    ]);
  });

  it('flags a string source with an array target', () => {
    const source = { items: 'one thing' };
    const target = { items: ['a', 'b'] };
    expect(findStructureMismatches(source, target)).toEqual([
      { key: 'items', sourceShape: 'string', targetShape: 'array' }
    ]);
  });

  it('flags a flattened string source whose target became a map', () => {
    const source = { example: '{ "a": 1 }', title: 'T' };
    const target = { 'example.a': 1, title: 'T' };
    expect(findStructureMismatches(source, target)).toEqual([
      { key: 'example', sourceShape: 'string', targetShape: 'map' }
    ]);
  });

  it('does not flag a target that pluralizes a flat source string', () => {
    const source = { items: '%{count} items' };
    const target = { 'items.one': '%{count} rzecz', 'items.few': '%{count} rzeczy', 'items.other': '%{count} rzeczy' };
    expect(findStructureMismatches(source, target)).toEqual([]);
  });

  it('does not flag a missing target value as a structure mismatch', () => {
    const source = { title: { nested: 'Hello' } };
    const target = {};
    expect(findStructureMismatches(source, target)).toEqual([]);
  });
});

describe('findPluralShapeMismatches', () => {
  it('flags a Rails one/other group with no plural forms in the target', () => {
    const source = { 'key.one': '1 key', 'key.other': '%{count} keys' };
    const target = { key: 'nycklar' };
    expect(findPluralShapeMismatches(source, target)).toEqual([{ key: 'key' }]);
  });

  it('does not flag when the target also has plural forms', () => {
    const source = { 'key.one': '1 key', 'key.other': '%{count} keys' };
    const target = { 'key.one': '1 nyckel', 'key.other': '%{count} nycklar' };
    expect(findPluralShapeMismatches(source, target)).toEqual([]);
  });

  it('does not flag a lone "other" key with no sibling plural category', () => {
    const source = { 'status.other': 'Unknown' };
    const target = { status: { other: 'Okänd' } };
    expect(findPluralShapeMismatches(source, target)).toEqual([]);
  });

  it('does not flag when the target has nothing at all under that key (missing-key territory)', () => {
    const source = { 'key.one': '1 key', 'key.other': '%{count} keys' };
    const target = {};
    expect(findPluralShapeMismatches(source, target)).toEqual([]);
  });
});

describe('findEmptyAndIdentical', () => {
  it('reports an empty target string separately from an identical one', () => {
    const source = { a: 'Hello', b: 'OK' };
    const target = { a: '', b: 'OK' };
    const result = findEmptyAndIdentical(source, target);
    expect(result.empty).toEqual([{ key: 'a', source: 'Hello' }]);
    expect(result.identical).toEqual([{ key: 'b', value: 'OK' }]);
  });

  it('treats identical-to-source as a hint, not folded into empty', () => {
    const source = { brand: 'Localhero' };
    const target = { brand: 'Localhero' };
    const result = findEmptyAndIdentical(source, target);
    expect(result.empty).toEqual([]);
    expect(result.identical).toEqual([{ key: 'brand', value: 'Localhero' }]);
  });
});

describe('plural forms', () => {
  it('reports a placeholder a Rails `one` form leaves out as a hint, not a mismatch', () => {
    const [finding] = findPlaceholderMismatches(
      { 'languages_count.one': '%{count} language' },
      { 'languages_count.one': '1 språk' }
    );
    expect(finding.hint).toBe(true);
  });

  it('reports the gettext zero form leaving out the number as a hint', () => {
    const [finding] = findPlaceholderMismatches(
      { item: '%(count)d item', item__plural_1: '%(count)d items' },
      { item: 'لا عناصر', item__plural_1: 'عنصر واحد', item__plural_2: '%(count)d عنصران' }
    );
    expect(finding.key).toBe('item');
    expect(finding.hint).toBe(true);
  });

  it('keeps a count dropped from a Rails `other` or `few` form as a real mismatch', () => {
    const found = findPlaceholderMismatches(
      { 'items.other': '%{count} items', 'items.few': '%{count} items' },
      { 'items.other': 'objekt', 'items.few': 'rzeczy' }
    );
    expect(found.map((f) => f.hint)).toEqual([undefined, undefined]);
  });

  it('keeps a count dropped from an i18next `_other` form as a real mismatch', () => {
    const [finding] = findPlaceholderMismatches({ msg_other: '{{count}} messages' }, { msg_other: 'meddelanden' });
    expect(finding.hint).toBeUndefined();
  });

  it('allows a plural form to add the count, which is always passed', () => {
    expect(findPlaceholderMismatches({ 'items.one': 'One item' }, { 'items.one': '%{count} vara' })).toEqual([]);
    expect(findPlaceholderMismatches({ msg_one: 'One message' }, { msg_one: '{{count}} viesti' })).toEqual([]);
  });

  it('keeps any other placeholder a plural form ADDS as a real mismatch', () => {
    const [finding] = findPlaceholderMismatches(
      { 'items.one': 'One item' },
      { 'items.one': '%{name}: en vara' }
    );
    expect(finding.unexpectedInTarget).toEqual(['rails:name']);
    expect(finding.hint).toBeUndefined();
  });

  it('keeps an added count outside a plural form as a real mismatch', () => {
    const [finding] = findPlaceholderMismatches({ title: 'Items' }, { title: '%{count} varor' });
    expect(finding.unexpectedInTarget).toEqual(['rails:count']);
  });

  it('keeps an omission outside a plural form as a real mismatch', () => {
    const [finding] = findPlaceholderMismatches({ greeting: 'Hi %{name}' }, { greeting: 'Hej' });
    expect(finding.hint).toBeUndefined();
  });

  it('does not report the extra plural forms of a language as orphans', () => {
    const orphans = findOrphanKeys(
      { item: 'item', item__plural_1: 'items' },
      { item: 'a', item__plural_1: 'b', item__plural_2: 'c', item__plural_5: 'd', stale: 'e' }
    );
    expect(orphans.map((o) => o.key)).toEqual(['stale']);
  });
});

describe('findMissingPluralCategories', () => {
  it('flags Polish plural groups that only carry the English categories (#636)', () => {
    const target = { 'archived_count.one': '%{count} zadanie', 'archived_count.other': '%{count} zadania' };
    expect(findMissingPluralCategories(target, 'pl')).toEqual([{ key: 'archived_count', missing: ['few', 'many'] }]);
  });

  it('accepts a complete group and ignores a lone `other` that is not a plural', () => {
    const target = { 'n.one': 'a', 'n.other': 'b', 'status.other': 'Annat' };
    expect(findMissingPluralCategories(target, 'sv')).toEqual([]);
  });

  it('does not demand the Spanish `many` that only applies to millions', () => {
    expect(findMissingPluralCategories({ 'n.one': 'a', 'n.other': 'b' }, 'es')).toEqual([]);
  });
});

describe('plural groups with categories only some languages use (#636 workaround)', () => {
  it('does not report Polish `few`/`many` under an English `one`/`other` group as orphans', () => {
    const orphans = findOrphanKeys(
      { 'n.one': 'a', 'n.other': 'b' },
      { 'n.one': 'a', 'n.few': 'c', 'n.many': 'd', 'n.other': 'b', 'old.few': 'e' }
    );
    expect(orphans.map((o) => o.key)).toEqual(['old.few']);
  });
});

describe('findConflictingKeys', () => {
  it('reports a key two files define with different values', () => {
    const found = findConflictingKeys([
      { path: 'config/locales/app/sv.yml', keys: { 'app.title': 'Ny titel', 'app.ok': 'OK' } },
      { path: 'config/locales/pages/sv.yml', keys: { 'app.title': 'Gammal titel', 'app.ok': 'OK' } }
    ]);
    expect(found).toEqual([
      {
        key: 'app.title',
        files: ['config/locales/app/sv.yml', 'config/locales/pages/sv.yml'],
        values: ['Ny titel', 'Gammal titel']
      }
    ]);
  });

  it('does not report a key defined with the same value in several files', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { title: 'Titel', days: ['Mån', 'Tis'] } },
      { path: 'b/sv.yml', keys: { title: 'Titel', days: ['Mån', 'Tis'] } }
    ]);
    expect(found).toEqual([]);
  });

  it('lists every file defining a conflicting key, including ones that agree', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { title: 'Titel' } },
      { path: 'b/sv.yml', keys: { title: 'Titel' } },
      { path: 'c/sv.yml', keys: { title: 'Rubrik' } }
    ]);
    expect(found).toEqual([
      { key: 'title', files: ['a/sv.yml', 'b/sv.yml', 'c/sv.yml'], values: ['Titel', 'Titel', 'Rubrik'] }
    ]);
  });

  it('compares arrays by content', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { days: ['Mån', 'Tis'] } },
      { path: 'b/sv.yml', keys: { days: ['Mån', 'Ons'] } }
    ]);
    expect(found).toEqual([
      { key: 'days', files: ['a/sv.yml', 'b/sv.yml'], values: ['["Mån","Tis"]', '["Mån","Ons"]'] }
    ]);
  });

  it('ignores a key left without a value in one file', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { title: 'Titel' } },
      { path: 'b/sv.yml', keys: { title: null } }
    ]);
    expect(found).toEqual([]);
  });

  it('treats an empty string as a value that conflicts with text', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { title: 'Titel' } },
      { path: 'b/sv.yml', keys: { title: '' } }
    ]);
    expect(found.map((f) => f.key)).toEqual(['title']);
  });

  it('reports false and 0 as values', () => {
    const found = findConflictingKeys([
      { path: 'a/sv.yml', keys: { enabled: true, precision: 2 } },
      { path: 'b/sv.yml', keys: { enabled: false, precision: 0 } }
    ]);
    expect(found.map((f) => f.key)).toEqual(['enabled', 'precision']);
  });
});
