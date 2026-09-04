import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

describe('YAML scalar style preservation on update', () => {
  let tempDir: string;
  let filePath: string;

  const initial = [
    'en:',
    '  literal: |-',
    '    First line here',
    '    Second line here',
    '  folded: >-',
    '    Some folded',
    '    text here',
    '  single: \'quoted single\'',
    '  double: "quoted double"',
    '  untouched: |-',
    '    Leave me',
    '    exactly alone',
    ''
  ].join('\n');

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-yaml-style-'));
    filePath = path.join(tempDir, 'en.yml');
    await fs.writeFile(filePath, initial, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps a literal block scalar as |- when its value is updated', async () => {
    await updateTranslationFile(filePath, { literal: 'Updated first line\nUpdated second line' }, 'en');

    const result = await fs.readFile(filePath, 'utf8');
    expect(result).toContain('literal: |-');
    expect(result).toContain('    Updated first line\n    Updated second line');
  });

  it('keeps a folded block scalar as >- when its value is updated', async () => {
    await updateTranslationFile(filePath, { folded: 'Updated folded\ntext here' }, 'en');

    const result = await fs.readFile(filePath, 'utf8');
    expect(result).toContain('folded: >-');
  });

  it('keeps single and double quoting when those values are updated', async () => {
    await updateTranslationFile(filePath, { single: 'new single', double: 'new double' }, 'en');

    const result = await fs.readFile(filePath, 'utf8');
    expect(result).toContain("single: 'new single'");
    expect(result).toContain('double: "new double"');
  });

  it('does not disturb untouched block scalars when a sibling is updated', async () => {
    await updateTranslationFile(filePath, { single: 'new single' }, 'en');

    const result = await fs.readFile(filePath, 'utf8');
    expect(result).toContain('untouched: |-\n    Leave me\n    exactly alone');
  });
});
