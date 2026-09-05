import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('yaml write-time re-parse guard (#509)', () => {
  let tempDir: string;
  let originalConsole: typeof console;

  beforeEach(async () => {
    jest.resetModules();

    await jest.unstable_mockModule('../../../src/utils/translation-updater/yaml-splicer.js', () => ({
      spliceYamlUpdate: () => ({
        // Deliberately invalid: a scalar value with a mapping nested under it,
        // the exact shape from the #509 production incident.
        output: 'de:\n  sidebar:\n    unexported_change: value\n      completed: broken\n',
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

  it('falls back to a full-document rewrite instead of writing splice output that fails to parse', async () => {
    const { updateYamlFile } = await import('../../../src/utils/translation-updater/yaml-handler.js');
    const yaml = (await import('yaml')).default;

    const filePath = path.join(tempDir, 'de.yml');
    const initialContent = 'de:\n  sidebar:\n    completed: ok\n';
    fs.writeFileSync(filePath, initialContent);

    await updateYamlFile(filePath, { 'sidebar.unexported_change': 'value' }, 'de');

    const contentAfter = fs.readFileSync(filePath, 'utf8');
    expect(yaml.parseDocument(contentAfter, { strict: true }).errors).toEqual([]);
    expect(yaml.parse(contentAfter)).toEqual({
      de: { sidebar: { completed: 'ok', unexported_change: 'value' } }
    });
  });
});
