import { describe, it, expect } from '@jest/globals';
import { changedKeys, createChangeMatcher, diffAgainstBase } from '../../src/utils/check-changes.js';
import { parseFile, flattenTranslations } from '../../src/utils/files.js';
import type { TranslationFile } from '../../src/types/index.js';
import { fakeGit } from '../helpers/fake-git.js';

describe('changedKeys', () => {
  it('lists added, changed and removed keys', () => {
    const before = { same: 'A', edited: 'B', gone: 'C', emptied: 'D' };
    const after = { same: 'A', edited: 'B2', added: 'E', emptied: '' };

    expect([...changedKeys(before, after)].sort()).toEqual(['added', 'edited', 'emptied', 'gone']);
  });

  it('compares arrays and PO entries by value', () => {
    const before = { list: ['a', 'b'], po: { value: 'Hej', metadata: { po_plural: true } } };
    const after = { list: ['a', 'b'], po: { value: 'Hej', metadata: { po_plural: true } } };

    expect(changedKeys(before, after).size).toBe(0);
  });

  it('treats 0 and false as values', () => {
    expect([...changedKeys({ a: 0, b: false }, { a: null, b: false })]).toEqual(['a']);
  });
});

describe('createChangeMatcher', () => {
  it('matches a changed key and nothing else', () => {
    const matches = createChangeMatcher(new Set(['a.b']));

    expect(matches('a.b')).toBe(true);
    expect(matches('a.c')).toBe(false);
    expect(matches('b')).toBe(false);
  });

  it('matches a finding on the parent of a changed key', () => {
    const matches = createChangeMatcher(new Set(['items.one']));

    expect(matches('items')).toBe(true);
  });

  it('matches every Rails plural form when one form changed', () => {
    const matches = createChangeMatcher(new Set(['items.one', 'items.other']));

    expect(matches('items.few')).toBe(true);
    expect(matches('other.few')).toBe(false);
  });

  it('matches every gettext plural form when the singular changed', () => {
    const matches = createChangeMatcher(new Set(['ctx|%d file']));

    expect(matches('ctx|%d file__plural_3')).toBe(true);
    expect(matches('%d file__plural_1')).toBe(false);
  });

  it('matches every i18next plural form when one form changed', () => {
    const matches = createChangeMatcher(new Set(['cart.item_one']));

    expect(matches('cart.item_few')).toBe(true);
    expect(matches('cart.other_few')).toBe(false);
  });

  it('matches nothing when nothing changed', () => {
    expect(createChangeMatcher(new Set())('a')).toBe(false);
  });
});

describe('diffAgainstBase', () => {
  const base = { ref: 'base', label: 'main' };
  const file: TranslationFile = { path: 'config/locales/sv.yml', format: 'yml', locale: 'sv' };
  const read = (f: TranslationFile) =>
    flattenTranslations(parseFile(Buffer.from(f.content ?? '', 'base64').toString('utf8'), f.format).sv);
  const inputs = (keys: Record<string, string>) => ({
    sources: [],
    targets: [{ locale: 'sv', file, keys }],
    readSource: read,
    readTarget: read
  });

  it('scopes target changes by locale and path', () => {
    const git = fakeGit({ files: { base: { 'config/locales/sv.yml': 'sv:\n  a: "A"\n  b: "B"\n' } } });

    const changes = diffAgainstBase(git, base, inputs({ a: 'A', b: 'B2' }));

    expect(changes.inTarget('sv', file.path, 'b')).toBe(true);
    expect(changes.inTarget('sv', file.path, 'a')).toBe(false);
    expect(changes.inTarget('de', file.path, 'b')).toBe(false);
  });

  it('counts every key of a file the base did not have as changed', () => {
    const git = fakeGit({ files: { base: {} } });

    expect(diffAgainstBase(git, base, inputs({ a: 'A' })).inTarget('sv', file.path, 'a')).toBe(true);
  });

  it('counts every key as changed when the base version does not parse', () => {
    const git = fakeGit({ files: { base: { 'config/locales/sv.yml': 'sv: [unclosed' } } });

    expect(diffAgainstBase(git, base, inputs({ a: 'A' })).inTarget('sv', file.path, 'a')).toBe(true);
  });

  it('reads a base version with a duplicate key', () => {
    const git = fakeGit({ files: { base: { 'config/locales/sv.yml': 'sv:\n  a: "Old"\n  a: "A"\n' } } });

    expect(diffAgainstBase(git, base, inputs({ a: 'A' })).inTarget('sv', file.path, 'a')).toBe(false);
  });

  it('throws when git cannot read the base', () => {
    expect(() => diffAgainstBase(fakeGit({}), base, inputs({ a: 'A' }))).toThrow();
  });
});
