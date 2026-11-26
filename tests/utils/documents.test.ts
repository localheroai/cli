import { describe, it, expect } from '@jest/globals';
import {
  MAX_DOCUMENT_CHARACTERS,
  buildDocumentBatches,
  documentFormatFor,
  documentKeyName,
  documentLength,
  documentLocale,
  documentTargetPath,
  findMissingDocuments,
  isDocumentPath,
  leaveOutUnsupportedDocuments,
  patternNamesExtension,
  toLfText
} from '../../src/utils/documents.js';

import type { TranslationFile } from '../../src/types/index.js';

const locales = ['en', 'sv', 'de', 'pt-BR'];

function article(filePath: string, locale: string, text: string, documentFormat: TranslationFile['documentFormat'] = 'markdown'): TranslationFile {
  return {
    path: filePath,
    format: filePath.split('.').pop() as string,
    locale,
    documentFormat,
    content: Buffer.from(text).toString('base64')
  };
}

function envelope(batch: { sourceFile: { content: string } }): unknown {
  return JSON.parse(Buffer.from(batch.sourceFile.content, 'base64').toString());
}

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

describe('findMissingDocuments', () => {
  const config = { sourceLocale: 'en', outputLocales: ['sv', 'de'] };
  const english = '# Export a report\n\nOpen **Reports**.\n';

  it('lists every output locale without a target file, at the target path', () => {
    const missing = findMissingDocuments([article('articles/en/export-reports.md', 'en', english)], { sv: [], de: [] }, config);

    expect(missing).toEqual({
      'sv:articles/en/export-reports.md': {
        locale: 'sv',
        path: 'articles/en/export-reports.md',
        targetPath: 'articles/sv/export-reports.md',
        keys: { 'export-reports.md': { value: english } },
        keyCount: 1
      },
      'de:articles/en/export-reports.md': {
        locale: 'de',
        path: 'articles/en/export-reports.md',
        targetPath: 'articles/de/export-reports.md',
        keys: { 'export-reports.md': { value: english } },
        keyCount: 1
      }
    });
  });

  it('leaves out a locale whose target file has text', () => {
    const targets = { sv: [article('articles/sv/export-reports.md', 'sv', '# Exportera\n')], de: [] };

    const missing = findMissingDocuments([article('articles/en/export-reports.md', 'en', english)], targets, config);

    expect(Object.keys(missing)).toEqual(['de:articles/en/export-reports.md']);
  });

  it('counts an empty or whitespace target as missing', () => {
    const targets = {
      sv: [article('articles/sv/export-reports.md', 'sv', '')],
      de: [article('articles/de/export-reports.md', 'de', ' \n\n')]
    };

    const missing = findMissingDocuments([article('articles/en/export-reports.md', 'en', english)], targets, config);

    expect(Object.keys(missing).sort()).toEqual(['de:articles/en/export-reports.md', 'sv:articles/en/export-reports.md']);
  });

  it('pairs by the exact target path, not by a file name in another folder', () => {
    const targets = { sv: [article('articles/sv/other/nested-guide.md', 'sv', '# Guide\n')], de: [] };

    const missing = findMissingDocuments([article('articles/en/sub/nested-guide.md', 'en', '# Guide\n')], targets, config);

    expect(missing['sv:articles/en/sub/nested-guide.md'].targetPath).toBe('articles/sv/sub/nested-guide.md');
  });

  it('sends an article whose text holds a marker that skips a key', () => {
    const text = '# Draft checklist\n\nName the branch `wip_checklist` or use __skip_translation__.\n';

    const missing = findMissingDocuments([article('articles/en/draft-checklist.md', 'en', text)], { sv: [], de: [] }, config);

    expect(missing['sv:articles/en/draft-checklist.md'].keys).toEqual({ 'draft-checklist.md': { value: text } });
  });

  it('holds the LF text of a CRLF source', () => {
    const missing = findMissingDocuments([article('articles/en/windows.md', 'en', '# Title\r\n\r\nBody\r\n')], { sv: [], de: [] }, config);

    expect(missing['sv:articles/en/windows.md'].keys).toEqual({ 'windows.md': { value: '# Title\n\nBody\n' } });
  });
});

describe('buildDocumentBatches', () => {
  const config = { sourceLocale: 'en', outputLocales: ['sv', 'de'] };
  const english = '# Export a report\n\nPress {{ui.save}} 🎉\n';

  function missingFor(filePath: string, text: string) {
    return findMissingDocuments([article(filePath, 'en', text)], { sv: [], de: [] }, config);
  }

  it('builds one batch per article with all its locales', () => {
    const missing = {
      ...missingFor('articles/en/export-reports.md', english),
      ...missingFor('articles/en/sub/nested-guide.md', '# Guide\n')
    };

    const { batches, refused } = buildDocumentBatches(missing);

    expect(refused).toEqual([]);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      sourceFilePath: 'articles/en/export-reports.md',
      localeEntries: ['sv:articles/en/export-reports.md', 'de:articles/en/export-reports.md'],
      locales: ['sv', 'de']
    });
  });

  it('sends the article as one key holding only its value, in the markdown wire format', () => {
    const { batches } = buildDocumentBatches(missingFor('articles/en/export-reports.md', english));

    expect(batches[0].sourceFile.path).toBe('articles/en/export-reports.md');
    expect(batches[0].sourceFile.format).toBe('markdown');
    expect(Object.keys(batches[0].sourceFile).sort()).toEqual(['content', 'format', 'path']);
    expect(envelope(batches[0])).toEqual({ keys: { 'export-reports.md': { value: english } } });
  });

  it('refuses an article over the limit and builds no batch for it', () => {
    const tooLong = 'a'.repeat(MAX_DOCUMENT_CHARACTERS + 1);

    const { batches, refused } = buildDocumentBatches(missingFor('articles/en/long-read.md', tooLong));

    expect(batches).toEqual([]);
    expect(refused).toEqual([
      { path: 'articles/en/long-read.md', reason: `the article has ${MAX_DOCUMENT_CHARACTERS + 1} characters, the limit is ${MAX_DOCUMENT_CHARACTERS}` }
    ]);
  });

  it('counts the limit in code points', () => {
    const atLimit = '🎉'.repeat(MAX_DOCUMENT_CHARACTERS);

    const { batches, refused } = buildDocumentBatches(missingFor('articles/en/party.md', atLimit));

    expect(refused).toEqual([]);
    expect(batches).toHaveLength(1);
  });

  it('refuses an empty article', () => {
    const { batches, refused } = buildDocumentBatches(missingFor('articles/en/empty.md', ' \n'));

    expect(batches).toEqual([]);
    expect(refused).toEqual([{ path: 'articles/en/empty.md', reason: 'the article is empty' }]);
  });
});

describe('leaveOutUnsupportedDocuments', () => {
  it('drops MDX and HTML from every list and names the source ones', () => {
    const key = { path: 'categories/en/topics.yml', format: 'yml', locale: 'en' };
    const markdown = article('articles/en/export-reports.md', 'en', '# Export\n');
    const mdx = article('articles/en/widget.mdx', 'en', '# Widget\n', 'mdx');
    const html = article('articles/sv/page.html', 'sv', '<h1>Sida</h1>', 'html');

    const result = leaveOutUnsupportedDocuments({
      allFiles: [key, markdown, mdx, html],
      sourceFiles: [key, markdown, mdx],
      targetFilesByLocale: { sv: [html] },
      parseFailures: []
    });

    expect(result.allFiles).toEqual([key, markdown]);
    expect(result.sourceFiles).toEqual([key, markdown]);
    expect(result.targetFilesByLocale).toEqual({ sv: [] });
    expect(result.unsupported).toEqual([{ path: 'articles/en/widget.mdx', reason: 'MDX articles are not supported yet' }]);
  });
});
