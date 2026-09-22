import { describe, it, expect } from '@jest/globals';
import {
  findOrphanKeys,
  findPlaceholderMismatches,
  findStructureMismatches,
  findPluralShapeMismatches,
  findEmptyAndIdentical
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
