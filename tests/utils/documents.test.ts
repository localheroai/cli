import { describe, it, expect } from '@jest/globals';
import {
  MAX_DOCUMENT_CHARACTERS,
  documentFormatFor,
  documentKeyName,
  documentLength,
  documentLocale,
  documentTargetPath,
  isDocumentPath,
  patternNamesExtension,
  toLfText
} from '../../src/utils/documents.js';

const locales = ['en', 'sv', 'de', 'pt-BR'];

describe('documentFormatFor', () => {
  it.each([
    ['articles/en/export-reports.md', 'markdown'],
    ['articles/en/export-reports.markdown', 'markdown'],
    ['articles/en/EXPORT.MD', 'markdown'],
    ['articles/en/widget.mdx', 'mdx'],
    ['articles/en/page.html', 'html'],
    ['articles/en/page.htm', 'html']
  ])('reads %s as %s', (filePath, format) => {
    expect(documentFormatFor(filePath)).toBe(format);
    expect(isDocumentPath(filePath)).toBe(true);
  });

  it.each(['locales/en.yml', 'locales/en.json', 'locale/sv/LC_MESSAGES/django.po', 'articles/en/md'])(
    'does not read %s as a document',
    (filePath) => {
      expect(documentFormatFor(filePath)).toBeNull();
      expect(isDocumentPath(filePath)).toBe(false);
    }
  );
});

describe('documentLocale', () => {
  it('returns the one directory segment that is a configured locale', () => {
    expect(documentLocale('articles/en/export-reports.md', locales)).toBe('en');
    expect(documentLocale('articles/sv/sub/nested-guide.md', locales)).toBe('sv');
  });

  it('never reads the locale from the file name', () => {
    expect(documentLocale('articles/en/sv.md', locales)).toBe('en');
    expect(documentLocale('articles/en/notes-sv.md', locales)).toBe('en');
    expect(documentLocale('articles/sv.md', locales)).toBeNull();
  });

  it('returns the configured spelling for a segment in another case', () => {
    expect(documentLocale('articles/pt-br/export-reports.md', locales)).toBe('pt-BR');
    expect(documentLocale('articles/EN/export-reports.md', locales)).toBe('en');
  });

  it('returns null without a locale segment', () => {
    expect(documentLocale('articles/export-reports.md', locales)).toBeNull();
    expect(documentLocale('export-reports.md', locales)).toBeNull();
  });

  it('returns null with two locale segments', () => {
    expect(documentLocale('articles/en/de/export-reports.md', locales)).toBeNull();
    expect(documentLocale('en/articles/en/export-reports.md', locales)).toBeNull();
  });
});

describe('documentTargetPath', () => {
  it('replaces the locale segment and keeps the file name', () => {
    expect(documentTargetPath('articles/en/export-reports.md', 'sv', locales)).toBe('articles/sv/export-reports.md');
  });

  it('keeps a slug that is a locale code or ends in one', () => {
    expect(documentTargetPath('articles/en/en.md', 'sv', locales)).toBe('articles/sv/en.md');
    expect(documentTargetPath('articles/en/notes-en.md', 'sv', locales)).toBe('articles/sv/notes-en.md');
  });

  it('keeps every segment after the locale', () => {
    expect(documentTargetPath('articles/en/sub/nested-guide.md', 'de', locales)).toBe('articles/de/sub/nested-guide.md');
  });

  it('writes the target locale as spelled in the configuration', () => {
    expect(documentTargetPath('articles/en/export-reports.md', 'pt-BR', locales)).toBe('articles/pt-BR/export-reports.md');
    expect(documentTargetPath('articles/EN/export-reports.md', 'sv', locales)).toBe('articles/sv/export-reports.md');
  });

  it('returns null for a path without exactly one locale segment', () => {
    expect(documentTargetPath('articles/export-reports.md', 'sv', locales)).toBeNull();
    expect(documentTargetPath('articles/en/de/export-reports.md', 'sv', locales)).toBeNull();
  });
});

describe('documentKeyName', () => {
  it('is the file name with its extension, case kept', () => {
    expect(documentKeyName('articles/en/Export-Reports.md')).toBe('Export-Reports.md');
    expect(documentKeyName('articles/en/sub/nested-guide.markdown')).toBe('nested-guide.markdown');
  });
});

describe('toLfText', () => {
  it('turns CRLF into LF and leaves everything else alone', () => {
    expect(toLfText('# Title\r\n\r\nBody\r\n')).toBe('# Title\n\nBody\n');
    expect(toLfText('# Title\n\nBody')).toBe('# Title\n\nBody');
    expect(toLfText('  lead\r\ntrail  ')).toBe('  lead\ntrail  ');
  });
});

describe('documentLength', () => {
  it('counts Unicode code points, not UTF-16 units', () => {
    expect('🎉'.length).toBe(2);
    expect(documentLength('🎉')).toBe(1);
    expect(documentLength('Klart 🎉')).toBe(7);
  });

  it('puts a text of exactly the limit in emoji under the limit', () => {
    const text = '🎉'.repeat(MAX_DOCUMENT_CHARACTERS);
    expect(text.length).toBe(MAX_DOCUMENT_CHARACTERS * 2);
    expect(documentLength(text)).toBe(MAX_DOCUMENT_CHARACTERS);
  });
});

describe('patternNamesExtension', () => {
  it('finds the extension in a brace list', () => {
    expect(patternNamesExtension('**/*.{json,yml,yaml,md}', 'md')).toBe(true);
    expect(patternNamesExtension('**/*.{json,yml,yaml,md}', 'markdown')).toBe(false);
  });

  it('finds a single extension', () => {
    expect(patternNamesExtension('**/*.md', 'md')).toBe(true);
    expect(patternNamesExtension('*.MD', 'md')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(patternNamesExtension('**/*.mdx', 'md')).toBe(false);
    expect(patternNamesExtension('**/*.{json,mdx}', 'md')).toBe(false);
  });

  it('looks at the last segment only', () => {
    expect(patternNamesExtension('md/**/*.yml', 'md')).toBe(false);
  });

  it('is false for the default pattern and for a wildcard', () => {
    expect(patternNamesExtension('**/*.{json,yml,yaml,po,pot}', 'md')).toBe(false);
    expect(patternNamesExtension('**/*', 'md')).toBe(false);
    expect(patternNamesExtension(undefined, 'md')).toBe(false);
  });
});
