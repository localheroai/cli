import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  updateTranslationFile,
  deleteKeysFromTranslationFile
} from '../../../src/utils/translation-updater/index.js';
import { DocumentWriteError } from '../../../src/utils/translation-updater/document-handler.js';
import { resetPathSerializer } from '../../../src/utils/translation-updater/path-serializer.js';

const TRANSLATED = '---\ntitle: "Exportera en rapport"\n---\n\n# Exportera en rapport\n\nÖppna **Rapporter** 🎉\n';

describe('writing a document file', () => {
  let directory: string;
  let sourcePath: string;
  let targetPath: string;

  async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(() => true, () => false);
  }

  beforeEach(async () => {
    resetPathSerializer();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-document-'));
    sourcePath = path.join(directory, 'articles/en/export-reports.md');
    targetPath = path.join(directory, 'articles/sv/export-reports.md');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, '# Export a report\n\nOpen **Reports**.\n');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('writes the value as the whole file, byte for byte', async () => {
    const result = await updateTranslationFile(targetPath, { 'export-reports.md': TRANSLATED }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe(TRANSLATED);
    expect(result).toEqual({ updatedKeys: ['export-reports.md'], created: true });
  });

  it.each([
    ['no final newline', '# Rubrik\n\nText'],
    ['two final newlines', '# Rubrik\n\nText\n\n'],
    ['leading blank lines and trailing spaces', '\n\n# Rubrik  \n\nText  \n']
  ])('adds and removes nothing for a value with %s', async (_name, value) => {
    await updateTranslationFile(targetPath, { 'export-reports.md': value }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe(value);
  });

  it('replaces an existing target whole', async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '# Gammal text\n\nEtt stycke som ska bort.\n\nOch ett till.\n');

    const result = await updateTranslationFile(targetPath, { 'export-reports.md': TRANSLATED }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe(TRANSLATED);
    expect(result.created).toBe(false);
  });

  it('gives a new target the line endings of its source', async () => {
    await fs.writeFile(sourcePath, '# Export a report\r\n\r\nOpen **Reports**.\r\n');

    await updateTranslationFile(targetPath, { 'export-reports.md': '# Rubrik\n\nText\n' }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe('# Rubrik\r\n\r\nText\r\n');
  });

  it('keeps the line endings of an existing target over those of its source', async () => {
    await fs.writeFile(sourcePath, '# Export a report\r\n\r\nOpen **Reports**.\r\n');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '# Gammal\n\nText\n');

    await updateTranslationFile(targetPath, { 'export-reports.md': '# Rubrik\n\nText\n' }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe('# Rubrik\n\nText\n');
  });

  it('keeps CRLF in an existing target', async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '# Gammal\r\n\r\nText\r\n');

    await updateTranslationFile(targetPath, { 'export-reports.md': '# Rubrik\n\nText' }, 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe('# Rubrik\r\n\r\nText');
  });

  it('writes LF with no target and no source to go by', async () => {
    await updateTranslationFile(targetPath, { 'export-reports.md': '# Rubrik\n\nText\n' }, 'sv');

    expect(await fs.readFile(targetPath, 'utf8')).toBe('# Rubrik\n\nText\n');
  });

  it('accepts the list form the sync uses', async () => {
    await updateTranslationFile(targetPath, [{ key: 'export-reports.md', value: TRANSLATED }], 'sv', sourcePath);

    expect(await fs.readFile(targetPath, 'utf8')).toBe(TRANSLATED);
  });

  it('writes nothing for a null value and creates no folder', async () => {
    const result = await updateTranslationFile(targetPath, { 'export-reports.md': null }, 'sv', sourcePath);

    expect(result).toEqual({ updatedKeys: [], created: false });
    expect(await exists(path.dirname(targetPath))).toBe(false);
  });

  it.each([
    ['two keys', { 'export-reports.md': 'Text', title: 'Rubrik' }],
    ['a key that is not the file name', { title: 'Rubrik' }],
    ['a key named after another article', { 'other-article.md': 'Text' }],
    ['a value that is not a string', { 'export-reports.md': { title: 'Rubrik' } }],
    ['a list value', { 'export-reports.md': ['Rubrik'] }],
    ['an empty value', { 'export-reports.md': '' }],
    ['a whitespace value', { 'export-reports.md': ' \n\n' }]
  ])('refuses %s and writes nothing', async (_name, translations) => {
    await expect(updateTranslationFile(targetPath, translations, 'sv', sourcePath)).rejects.toThrow(DocumentWriteError);

    expect(await exists(targetPath)).toBe(false);
  });

  it('never writes YAML into a document path that already exists', async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, TRANSLATED);

    await expect(updateTranslationFile(targetPath, { title: 'Rubrik' }, 'sv', sourcePath)).rejects.toThrow(DocumentWriteError);

    expect(await fs.readFile(targetPath, 'utf8')).toBe(TRANSLATED);
  });

  it('leaves a document alone when asked to delete keys from it', async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, TRANSLATED);

    const deleted = await deleteKeysFromTranslationFile(targetPath, ['export-reports.md', 'title'], 'sv');

    expect(deleted).toEqual([]);
    expect(await fs.readFile(targetPath, 'utf8')).toBe(TRANSLATED);
  });

  it('still writes a key file next to the articles as YAML', async () => {
    const yamlPath = path.join(directory, 'categories/sv/topics.yml');

    await updateTranslationFile(yamlPath, { 'topics.billing': 'Fakturering' }, 'sv');

    expect(await fs.readFile(yamlPath, 'utf8')).toContain('billing: Fakturering');
  });
});
