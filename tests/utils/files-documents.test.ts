import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { findTranslationFiles, parseFile } from '../../src/utils/files.js';
import type { TranslationConfig, TranslationFile, TranslationFilesResult } from '../../src/types/index.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');
const DEFAULT_PATTERN = '**/*.{json,yml,yaml,po,pot}';
const WITH_MARKDOWN = '**/*.{json,yml,yaml,md}';

function configWith(pattern?: string): TranslationConfig {
  return {
    sourceLocale: 'en',
    outputLocales: ['sv'],
    translationFiles: { paths: ['articles/', 'categories/'], ...(pattern && { pattern }) }
  };
}

function paths(files: TranslationFile[]): string[] {
  return files.map(file => file.path).sort();
}

describe('findTranslationFiles with documents', () => {
  let directory: string;
  let originalCwd: string;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'documents-')));
    cpSync(fixtures, directory, { recursive: true });
    process.chdir(directory);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  });

  const keyFiles = ['categories/en/topics.yml', 'categories/sv/topics.yml'];

  it('finds no documents with the default pattern, whatever the command asks for', async () => {
    const excluded = await findTranslationFiles(configWith()) as TranslationFile[];
    const included = await findTranslationFiles(configWith(DEFAULT_PATTERN), { documents: 'include' }) as TranslationFile[];

    expect(paths(excluded)).toEqual(keyFiles);
    expect(paths(included)).toEqual(keyFiles);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves documents out by default even when the pattern names md', async () => {
    const files = await findTranslationFiles(configWith(WITH_MARKDOWN)) as TranslationFile[];

    expect(paths(files)).toEqual(keyFiles);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not turn a wildcard pattern into an opt-in', async () => {
    const files = await findTranslationFiles(configWith('**/*.*'), { documents: 'include' }) as TranslationFile[];

    expect(paths(files)).toEqual(keyFiles);
  });

  it('returns documents when the command asks and the pattern names md', async () => {
    const result = await findTranslationFiles(configWith(WITH_MARKDOWN), {
      documents: 'include',
      returnFullResult: true
    }) as TranslationFilesResult;

    expect(paths(result.sourceFiles)).toEqual([
      'articles/en/README.md',
      'articles/en/draft-checklist.md',
      'articles/en/en.md',
      'articles/en/export-reports.md',
      'articles/en/notes-en.md',
      'articles/en/sub/nested-guide.md',
      'categories/en/topics.yml'
    ]);
    expect(paths(result.targetFilesByLocale.sv)).toEqual(['articles/sv/export-reports.md', 'categories/sv/topics.yml']);

    const article = result.sourceFiles.find(file => file.path === 'articles/en/export-reports.md');
    const raw = readFileSync('articles/en/export-reports.md', 'utf-8');
    expect(article).toMatchObject({
      format: 'md',
      locale: 'en',
      documentFormat: 'markdown',
      hasLanguageWrapper: false,
      content: Buffer.from(raw).toString('base64'),
      keys: { 'export-reports.md': raw }
    });
    expect(result.sourceFiles.find(file => file.path === 'categories/en/topics.yml')?.documentFormat).toBeUndefined();
  });

  it('takes the locale from the folder, never from a slug that looks like a locale', async () => {
    writeFileSync('articles/en/sv.md', '# Swedish, the language\n');

    const result = await findTranslationFiles(configWith(WITH_MARKDOWN), {
      documents: 'include',
      returnFullResult: true
    }) as TranslationFilesResult;

    expect(paths(result.sourceFiles)).toContain('articles/en/sv.md');
    expect(paths(result.targetFilesByLocale.sv)).not.toContain('articles/en/sv.md');
  });

  it('skips a document without exactly one locale folder and warns', async () => {
    mkdirSync('articles/en/sv', { recursive: true });
    writeFileSync('articles/en/sv/two-locales.md', '# Two\n');
    writeFileSync('articles/loose.md', '# Loose\n');

    const files = await findTranslationFiles(configWith(WITH_MARKDOWN), { documents: 'include' }) as TranslationFile[];

    expect(paths(files)).not.toContain('articles/en/sv/two-locales.md');
    expect(paths(files)).not.toContain('articles/loose.md');
    const warnings = warn.mock.calls.map(call => String(call[0]));
    expect(warnings.some(text => text.includes('Could not extract locale from path: articles/loose.md'))).toBe(true);
    expect(warnings.some(text => text.includes('Could not extract locale from path: articles/en/sv/two-locales.md'))).toBe(true);
  });

  it('holds a CRLF document as LF text and its content as the raw file', async () => {
    const crlf = '# Title\r\n\r\nBody\r\n';
    writeFileSync('articles/en/windows.md', crlf);

    const files = await findTranslationFiles(configWith(WITH_MARKDOWN), { documents: 'include' }) as TranslationFile[];
    const file = files.find(candidate => candidate.path === 'articles/en/windows.md');

    expect(file?.keys).toEqual({ 'windows.md': '# Title\n\nBody\n' });
    expect(Buffer.from(file?.content ?? '', 'base64').toString()).toBe(crlf);
  });

  it('marks MDX and HTML with their own format when the pattern names them', async () => {
    writeFileSync('articles/en/widget.mdx', '# Widget\n');
    writeFileSync('articles/en/page.html', '<h1>Page</h1>\n');

    const files = await findTranslationFiles(configWith('**/*.{md,mdx,html}'), { documents: 'include' }) as TranslationFile[];

    expect(files.find(file => file.path === 'articles/en/widget.mdx')?.documentFormat).toBe('mdx');
    expect(files.find(file => file.path === 'articles/en/page.html')?.documentFormat).toBe('html');
  });

  it('returns documents without content when the caller wants paths only', async () => {
    const files = await findTranslationFiles(configWith(WITH_MARKDOWN), {
      documents: 'include',
      parseContent: false,
      includeContent: false,
      extractKeys: false
    }) as TranslationFile[];

    expect(files.find(file => file.path === 'articles/en/export-reports.md')).toEqual({
      path: 'articles/en/export-reports.md',
      format: 'md',
      locale: 'en',
      documentFormat: 'markdown'
    });
  });
});

describe('parseFile with a document', () => {
  it('returns one key named after the file holding the LF text', () => {
    expect(parseFile('# Title\r\n\r\nBody\r\n', 'md', 'articles/en/export-reports.md')).toEqual({
      'export-reports.md': '# Title\n\nBody\n'
    });
  });

  it('does not read front matter as YAML', () => {
    const text = '---\ntitle: "Export"\n---\n\n# Export\n';
    expect(parseFile(text, 'markdown', 'articles/en/export.markdown')).toEqual({ 'export.markdown': text });
  });

  it('still parses key files by their own format', () => {
    expect(parseFile('en:\n  hello: Hello\n', 'yml', 'locales/en.yml')).toEqual({ en: { hello: 'Hello' } });
    expect(parseFile('{"hello":"Hello"}', 'json', 'locales/en.json')).toEqual({ hello: 'Hello' });
  });
});
