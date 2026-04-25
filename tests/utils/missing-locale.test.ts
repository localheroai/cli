import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

describe('YAML missing-locale write creates a new top-level locale key', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-missing-'));
    filePath = path.join(tempDir, 'greet.i18n.yml');
    const initial = `---
en:
  greeting: Hello
sv:
  greeting: Hej
`;
    await fs.writeFile(filePath, initial, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('adds a new nb: block when sync writes to a locale not already in the file', async () => {
    await updateTranslationFile(filePath, { greeting: 'Hei' }, 'nb', filePath, 'en');

    const after = await fs.readFile(filePath, 'utf8');

    expect(after).toContain('en:');
    expect(after).toContain('sv:');
    expect(after).toContain('nb:');

    expect(after).toContain('  greeting: Hello');
    expect(after).toContain('  greeting: Hej');

    expect(after).toMatch(/nb:\n\s+greeting:/);
    expect(after).toContain('Hei');

    expect(after).not.toContain('fi:');
  });
});

describe('JSON missing-locale write creates a new top-level locale key', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-missing-'));
    filePath = path.join(tempDir, 'greet.i18n.json');
    const initial = {
      en: { greeting: 'Hello' },
      sv: { greeting: 'Hej' }
    };
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('adds a new nb key when sync writes to a locale not already in the file', async () => {
    await updateTranslationFile(filePath, { greeting: 'Hei' }, 'nb', filePath, 'en');

    const after = JSON.parse(await fs.readFile(filePath, 'utf8'));

    expect(Object.keys(after).sort()).toEqual(['en', 'nb', 'sv']);
    expect(after.en).toEqual({ greeting: 'Hello' });
    expect(after.sv).toEqual({ greeting: 'Hej' });
    expect(after.nb).toEqual({ greeting: 'Hei' });
  });
});
