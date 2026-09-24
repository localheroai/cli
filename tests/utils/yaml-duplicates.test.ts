import { describe, it, expect } from '@jest/globals';
import { findDuplicateYamlKeys, dedupeYaml } from '../../src/utils/yaml-duplicates.js';

const raw = 'sv:\n  a: "A-sv"\n  b: "Gammal"\n  nested:\n    x: "1"\n  b: "Ny"\n';

describe('findDuplicateYamlKeys', () => {
  it('lists each duplicated key with every value, without the locale wrapper', () => {
    expect(findDuplicateYamlKeys(raw, 'sv')).toEqual([{ key: 'b', values: ['Gammal', 'Ny'] }]);
  });

  it('finds nothing in a file without duplicates', () => {
    expect(findDuplicateYamlKeys('sv:\n  a: "A"\n', 'sv')).toEqual([]);
  });
});

describe('dedupeYaml', () => {
  it('keeps the last value, as Rails does', () => {
    expect(dedupeYaml(raw)).toBe('sv:\n  a: A-sv\n  b: Ny\n  nested:\n    x: "1"\n');
  });
});
