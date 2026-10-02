import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { findLocaleDirs } from '../../src/utils/check-config.js';

describe('findLocaleDirs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'locale-dirs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function folders(...dirs: string[]): void {
    for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  }

  it("finds an app's locale folders and leaves out dependencies, test data and anything too deep", async () => {
    folders(
      'packages/app/locales',
      'apps/web/public/locales',
      'lib/priv/gettext',
      'node_modules/pkg/locales',
      '.venv/lib/python3.11/site-packages/debug_toolbar/locale',
      'test/fixtures/locales',
      'a/b/c/d/e/f/g/locales'
    );

    expect(await findLocaleDirs(root)).toEqual(['apps/web/public/locales/', 'lib/priv/gettext/', 'packages/app/locales/']);
  });
});
