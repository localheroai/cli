import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('yaml delete write-time re-parse guard (#509)', () => {
  let tempDir: string;
  let originalConsole: typeof console;

  beforeEach(async () => {
    jest.resetModules();

    await jest.unstable_mockModule('../../../src/utils/translation-updater/yaml-splicer.js', () => ({
      spliceYamlUpdate: () => ({ output: '', applied: false }),
      spliceYamlDelete: () => ({
        // Deliberately invalid output, same shape as the update-side test.
        output: 'de:\n  sidebar:\n    unexported_change: value\n      completed: broken\n',
        deletedKeys: ['sidebar.removed']
      }),
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

  it('throws instead of writing when spliceYamlDelete produces output that fails to parse', async () => {
    const { deleteKeysFromYamlFile } = await import('../../../src/utils/translation-updater/yaml-handler.js');

    const filePath = path.join(tempDir, 'de.yml');
    const initialContent = 'de:\n  sidebar:\n    completed: ok\n    removed: gone\n';
    fs.writeFileSync(filePath, initialContent);

    await expect(deleteKeysFromYamlFile(filePath, ['sidebar.removed'], 'de'))
      .rejects.toThrow(/failed to re-parse/);

    const contentAfter = fs.readFileSync(filePath, 'utf8');
    expect(contentAfter).toBe(initialContent);
  });
});
