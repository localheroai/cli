import { describe, it, expect } from '@jest/globals';
import { baseFileSet, type FileSet } from '../../src/utils/check-changes.js';
import type { TranslationFile } from '../../src/types/index.js';
import { fakeGit } from '../helpers/fake-git.js';

const EN = 'config/locales/en.yml';
const SV = 'config/locales/sv.yml';

function current(): FileSet {
  const file = (path: string, locale: string): TranslationFile => ({ path, format: 'yml', locale, content: 'bm93' });
  return { sourceFiles: [file(EN, 'en')], targetFilesByLocale: { sv: [file(SV, 'sv')] }, duplicates: [] };
}

function text(file: TranslationFile | undefined): string {
  return Buffer.from(file?.content ?? '', 'base64').toString('utf8');
}

describe('baseFileSet', () => {
  it('reads each file as it was at the base', () => {
    const git = fakeGit({ files: { base: { [EN]: 'en:\n  a: "A"\n', [SV]: 'sv:\n  a: "A-sv"\n' } } });

    const files = baseFileSet(git, 'base', current(), []);

    expect(text(files.sourceFiles[0])).toBe('en:\n  a: "A"\n');
    expect(text(files.targetFilesByLocale.sv[0])).toBe('sv:\n  a: "A-sv"\n');
  });

  it('leaves out a file the base did not have or cannot parse', () => {
    const git = fakeGit({ files: { base: { [EN]: 'en: [unclosed' } } });

    expect(baseFileSet(git, 'base', current(), [])).toEqual({ sourceFiles: [], targetFilesByLocale: { sv: [] }, duplicates: [] });
  });

  it('reads a moved file from its old path under its current path', () => {
    const git = fakeGit({
      files: { base: { [EN]: 'en:\n  a: "A"\n', 'config/locales/old/sv.yml': 'sv:\n  a: "A-sv"\n' } },
      renames: { [SV]: 'config/locales/old/sv.yml' }
    });

    const files = baseFileSet(git, 'base', current(), []);

    expect(files.targetFilesByLocale.sv.map((f) => [f.path, text(f)])).toEqual([[SV, 'sv:\n  a: "A-sv"\n']]);
    expect(git.calls).toContainEqual(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=R', '--relative', 'base']);
  });

  it('includes a target file the change deleted', () => {
    const deleted = 'config/locales/extra/sv.yml';
    const git = fakeGit({ files: { base: { [EN]: 'en:\n  a: "A"\n', [SV]: 'sv:\n', [deleted]: 'sv:\n  a: "A-sv"\n' } } });

    const files = baseFileSet(git, 'base', current(), [{ path: deleted, format: 'yml', locale: 'sv' }]);

    expect(files.targetFilesByLocale.sv.map((f) => f.path)).toEqual([SV, deleted]);
  });

  it('deduplicates a base file with a repeated key and records the repeat', () => {
    const git = fakeGit({ files: { base: { [EN]: 'en:\n  a: "A"\n', [SV]: 'sv:\n  a: "Old"\n  a: "A-sv"\n' } } });

    const files = baseFileSet(git, 'base', current(), []);

    expect(text(files.targetFilesByLocale.sv[0])).toContain('A-sv');
    expect(files.duplicates).toEqual([{ locale: 'sv', path: SV, key: 'a', values: ['Old', 'A-sv'] }]);
  });

  it('throws when git cannot read the base', () => {
    expect(() => baseFileSet(fakeGit({}), 'base', current(), [])).toThrow();
  });
});
