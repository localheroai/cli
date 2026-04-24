import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  readFileContentWithKeys,
  resetPoWarning,
} from '../../src/utils/import-service.js';
import { createIgnoreMatcher } from '../../src/utils/ignore-keys.js';

const knownLocales = ['en', 'sv', 'nb', 'fi'];

describe('readFileContentWithKeys with ignoreMatcher', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignorekeys-'));
    resetPoWarning();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('removes matching keys from wrapped single-lang YAML and preserves surrounding formatting', async () => {
    const src = [
      'en:',
      '  navigation:',
      '    home: "Home"',
      '  activerecord:',
      '    errors:',
      '      messages:',
      '        foo: "bar"',
      '',
    ].join('\n');
    const p = path.join(tmp, 'en.yml');
    await fs.writeFile(p, src, 'utf8');
    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const out = await readFileContentWithKeys(
      p,
      { sourceLanguage: 'en', currentLanguage: 'en' },
      { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' }
    );
    const decoded = Buffer.from(out.content, 'base64').toString();
    expect(decoded).not.toMatch(/foo:/);
    expect(decoded).toContain('home: "Home"');
    const keyNames = out.keys.map((k) => k.name);
    expect(keyNames.length).toBe(1);
    expect(keyNames[0]).toMatch(/navigation\.home$/);
    expect(out.removed).toEqual([{ name: 'activerecord.errors.messages.foo', locale: undefined }]);
  });

  it('removes matching keys from wrapped single-lang TARGET YAML and tags removals with the file locale', async () => {
    const src = [
      'sv:',
      '  navigation:',
      '    home: "Hem"',
      '  activerecord:',
      '    errors:',
      '      foo: "bar"',
      '',
    ].join('\n');
    const p = path.join(tmp, 'sv.yml');
    await fs.writeFile(p, src, 'utf8');
    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const out = await readFileContentWithKeys(
      p,
      { sourceLanguage: 'en', currentLanguage: 'sv' },
      { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' }
    );
    expect(out.removed).toEqual([{ name: 'activerecord.errors.foo', locale: 'sv' }]);
  });

  it('removes matching keys from multi-lang YAML across all locale wrappers', async () => {
    const src = [
      '---',
      'en:',
      '  navigation:',
      '    home: "Home"',
      '  activerecord:',
      '    errors:',
      '      foo: "bar"',
      'sv:',
      '  navigation:',
      '    home: "Hem"',
      '  activerecord:',
      '    errors:',
      '      foo: "bar"',
      '',
    ].join('\n');
    const p = path.join(tmp, 'multilang.i18n.yml');
    await fs.writeFile(p, src, 'utf8');
    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const out = await readFileContentWithKeys(
      p,
      { sourceLanguage: 'en', currentLanguage: 'en' },
      { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' }
    );
    const decoded = Buffer.from(out.content, 'base64').toString();
    expect(decoded).not.toMatch(/foo:/);
    expect(decoded).toContain('home: "Home"');
    expect(decoded).toContain('home: "Hem"');
    const names = out.removed.map((r) => r.name);
    expect(names.every((n) => n === 'activerecord.errors.foo')).toBe(true);
    const locales = new Set(out.removed.map((r) => r.locale));
    expect(locales).toEqual(new Set([undefined, 'sv']));
  });

  it('filters JSON by deleting from flattened object', async () => {
    const src = JSON.stringify({
      navigation: { home: 'Home' },
      activerecord: { errors: { foo: 'bar' } },
    });
    const p = path.join(tmp, 'en.json');
    await fs.writeFile(p, src, 'utf8');
    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const out = await readFileContentWithKeys(
      p,
      { sourceLanguage: 'en', currentLanguage: 'en' },
      { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' }
    );
    const decoded = Buffer.from(out.content, 'base64').toString();
    const parsed = JSON.parse(decoded);
    expect(parsed['activerecord.errors.foo']).toBeUndefined();
    expect(parsed['navigation.home']).toBe('Home');
    expect(out.removed[0]?.name).toBe('activerecord.errors.foo');
  });

  it('skips PO files with a one-shot warning per process', async () => {
    const src = 'msgid "foo"\nmsgstr "bar"\n';
    const p1 = path.join(tmp, 'a.po');
    const p2 = path.join(tmp, 'b.po');
    await fs.writeFile(p1, src, 'utf8');
    await fs.writeFile(p2, src, 'utf8');
    const matcher = createIgnoreMatcher(['foo']);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      await readFileContentWithKeys(p1, undefined, { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' });
      await readFileContentWithKeys(p2, undefined, { ignoreMatcher: matcher, knownLocales, sourceLocale: 'en' });
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.filter((w) => w.includes('ignoreKeys does not yet support PO files')).length).toBe(1);
  });

  it('behaves identically to legacy when no ignoreMatcher is provided (YAML, wrapped)', async () => {
    const src = 'en:\n  foo: bar\n';
    const p = path.join(tmp, 'en.yml');
    await fs.writeFile(p, src, 'utf8');
    const out = await readFileContentWithKeys(p);
    expect(out.removed).toEqual([]);
    expect(out.keys.map((k) => k.name)).toEqual(['en.foo']);
  });

  it('JSON legacy vs filtered-but-nothing-matches produce identical payload shapes', async () => {
    const src = JSON.stringify({ en: { foo: { bar: 'x' } } });
    const p = path.join(tmp, 'en.json');
    await fs.writeFile(p, src, 'utf8');
    const nonMatching = createIgnoreMatcher(['no.such.prefix.*']);
    const legacy = await readFileContentWithKeys(p);
    const filtered = await readFileContentWithKeys(
      p,
      { sourceLanguage: 'en', currentLanguage: 'en' },
      { ignoreMatcher: nonMatching, knownLocales, sourceLocale: 'en' }
    );
    const legacyObj = JSON.parse(Buffer.from(legacy.content, 'base64').toString());
    const filteredObj = JSON.parse(Buffer.from(filtered.content, 'base64').toString());
    expect(filteredObj).toEqual(legacyObj);
    expect(filtered.removed).toEqual([]);
  });
});
