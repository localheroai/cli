import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile, deleteKeysFromTranslationFile } from '../../../src/utils/translation-updater/index.js';

const HAND_FORMATTED = `{
  "onboarding": {
    "steps": ["Write the release", "Add images and contacts", "Publish to your newsroom"],
    "nav": { "allNews": "All news", "drafts": "Drafts" }
  },
  "title": "Newsroom"
}
`;

const SAME_VALUES = {
  'onboarding.steps': ['Write the release', 'Add images and contacts', 'Publish to your newsroom'],
  'onboarding.nav.allNews': 'All news',
  title: 'Newsroom'
};

describe('JSON writes leave unchanged files alone (#859)', () => {
  let tempDir: string;
  let originalConsole: typeof console;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-json-noise-'));
    originalConsole = { ...console };
    global.console = { ...console, log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    global.console = originalConsole;
  });

  function writeFixture(name: string, content: string): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('leaves a hand-formatted file byte-identical when the values are unchanged', async () => {
    const filePath = writeFixture('en.json', HAND_FORMATTED);

    const result = await updateTranslationFile(filePath, SAME_VALUES, 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(HAND_FORMATTED);
    expect(result).toEqual({ updatedKeys: Object.keys(SAME_VALUES), created: false });
  });

  it('leaves a multi-language file byte-identical when one locale gets its own values', async () => {
    const content = `{
  "en": { "title": "Newsroom", "steps": ["Write", "Publish"] },
  "sv": { "title": "Nyhetsrum", "steps": ["Skriv", "Publicera"] }
}
`;
    const filePath = writeFixture('newsroom.json', content);

    await updateTranslationFile(filePath, { title: 'Nyhetsrum', steps: ['Skriv', 'Publicera'] }, 'sv');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });

  it('keeps the trailing newline when a value changes', async () => {
    const filePath = writeFixture('sv.json', '{\n  "title": "Nyhetsrum"\n}\n');

    await updateTranslationFile(filePath, { title: 'Pressrum' }, 'sv');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "title": "Pressrum"\n}\n');
  });

  it('does not add a trailing newline to a file that had none', async () => {
    const filePath = writeFixture('sv.json', '{\n  "title": "Nyhetsrum"\n}');

    await updateTranslationFile(filePath, { title: 'Pressrum' }, 'sv');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "title": "Pressrum"\n}');
  });

  it('ends a new file with a newline', async () => {
    const sourcePath = writeFixture('en.json', '{\n  "title": "Newsroom"\n}\n');
    const filePath = path.join(tempDir, 'de.json');

    const result = await updateTranslationFile(filePath, { title: 'Pressebereich' }, 'de', sourcePath);

    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "title": "Pressebereich"\n}\n');
    expect(result.created).toBe(true);
  });

  it('leaves a file byte-identical when none of the deleted keys are in it', async () => {
    const filePath = writeFixture('en.json', HAND_FORMATTED);

    const deleted = await deleteKeysFromTranslationFile(filePath, ['onboarding.removed', 'gone'], 'en');

    expect(deleted).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(HAND_FORMATTED);
  });

  it('keeps the trailing newline when a key is deleted', async () => {
    const filePath = writeFixture('en.json', '{\n  "title": "Newsroom",\n  "old": "Old"\n}\n');

    const deleted = await deleteKeysFromTranslationFile(filePath, ['old'], 'en');

    expect(deleted).toEqual(['old']);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{\n  "title": "Newsroom"\n}\n');
  });
});
