import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
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

  it('keeps a paragraph break intact when preserving a folded scalar', async () => {
    // A blank line survives folding (the emitter writes it as an extra newline), so the style is
    // preserved here. What matters is that the round-trip value is exact either way.
    await updateTranslationFile(filePath, { folded: 'First paragraph\n\nSecond paragraph' }, 'en');

    const parsed = YAML.parse(await fs.readFile(filePath, 'utf8')) as { en: { folded: string } };
    expect(parsed.en.folded).toBe('First paragraph\n\nSecond paragraph');
  });

  it('never trades value fidelity for style preservation', async () => {
    // The guard round-trips a candidate folded emit and falls back to |- if it would not
    // reproduce the value. Whatever style it lands on, the value must come back exactly.
    const awkward = [
      'Intro line\n    indented continuation',
      'Trailing spaces here   \nnext line',
      'First\n\n\nthree newlines',
      'Ends with newline\n'
    ];

    for (const value of awkward) {
      await updateTranslationFile(filePath, { folded: value }, 'en');
      const parsed = YAML.parse(await fs.readFile(filePath, 'utf8')) as { en: { folded: string } };
      expect(parsed.en.folded).toBe(value);
    }
  });

  it('round-trips every updated value unchanged whatever style is used', async () => {
    await updateTranslationFile(filePath, {
      literal: 'Line A\nLine B',
      folded: 'Folded A\nFolded B',
      single: 'plain single',
      double: 'plain double'
    }, 'en');

    const parsed = YAML.parse(await fs.readFile(filePath, 'utf8')) as { en: Record<string, string> };
    expect(parsed.en.literal).toBe('Line A\nLine B');
    expect(parsed.en.folded).toBe('Folded A\nFolded B');
    expect(parsed.en.single).toBe('plain single');
    expect(parsed.en.double).toBe('plain double');
  });

  it('does not disturb untouched block scalars when a sibling is updated', async () => {
    await updateTranslationFile(filePath, { single: 'new single' }, 'en');

    const result = await fs.readFile(filePath, 'utf8');
    expect(result).toContain('untouched: |-\n    Leave me\n    exactly alone');
  });
});
