import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('yaml write-time guard blocks NEW duplicate keys (#509)', () => {
  let tempDir: string;
  let originalConsole: typeof console;

  beforeEach(async () => {
    jest.resetModules();

    await jest.unstable_mockModule('../../../src/utils/translation-updater/yaml-splicer.js', () => ({
      // Valid YAML, but a bad insertion offset put the new key where a key
      // of the same name already exists — not a pre-existing duplicate,
      // one this write itself introduces.
      spliceYamlUpdate: () => ({
        output: 'de:\n  sidebar:\n    completed: ok\n    completed: also new\n',
        applied: true
      }),
      spliceYamlDelete: () => ({ output: '', deletedKeys: [] }),
      hasUnsupportedValueShape: () => false
    }));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-test-'));
    originalConsole = { ...console };
    global.console = {
      ...console,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    global.console = originalConsole;
  });

  it('falls back to a full-document rewrite instead of writing a splice that introduces a new duplicate key', async () => {
    const { updateYamlFile } = await import('../../../src/utils/translation-updater/yaml-handler.js');
    const yaml = (await import('yaml')).default;

    const filePath = path.join(tempDir, 'de.yml');
    // Source has no duplicates at all — "completed" appears exactly once.
    const initialContent = 'de:\n  sidebar:\n    completed: ok\n';
    fs.writeFileSync(filePath, initialContent);

    await updateYamlFile(filePath, { 'sidebar.completed': 'also new' }, 'de');

    const contentAfter = fs.readFileSync(filePath, 'utf8');
    const reparsed = yaml.parseDocument(contentAfter, { strict: true });
    expect(reparsed.errors).toEqual([]);
    // The fallback rewrite must not carry the duplicate through — a real
    // update to an existing scalar replaces it, it doesn't duplicate it.
    expect(yaml.parse(contentAfter)).toEqual({ de: { sidebar: { completed: 'also new' } } });
  });
});
