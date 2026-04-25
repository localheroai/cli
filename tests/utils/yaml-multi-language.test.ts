import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

const QASA_SHAPE = `---
en:
  headline: ''
  subject: Invitation
sv:
  headline: ''
  subject: ''
nb:
  headline: ''
  subject: ''
fi:
  headline: ''
  subject: ''
`;

function extractBlock(raw: string, locale: string): string[] {
  const lines = raw.split('\n');
  const startIndex = lines.findIndex(l => l === `${locale}:`);
  if (startIndex === -1) return [];

  const block: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      break;
    }
    block.push(line);
  }
  return block;
}

describe('YAML multi-language sequential writes preserve Qasa-shape formatting', () => {
  let tempDir: string;
  let multiLangPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-yaml-multi-'));
    multiLangPath = path.join(tempDir, 'invite.i18n.yml');
    await fs.writeFile(multiLangPath, QASA_SHAPE, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('preserves formatting across three sequential writes adding cta_button to sv/nb/fi', async () => {
    const sourceFilePath = multiLangPath;

    await updateTranslationFile(multiLangPath, { cta_button: 'Granska och signera' }, 'sv', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { cta_button: 'Gjennomgå og signer' }, 'nb', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { cta_button: 'Tarkista ja allekirjoita' }, 'fi', sourceFilePath, 'en');

    const raw = await fs.readFile(multiLangPath, 'utf8');

    expect(raw.startsWith('---\n')).toBe(true);

    const lines = raw.split('\n');
    const topLevelLocales = lines
      .filter(l => /^[a-z]{2,3}(-[A-Z]{2})?:$/.test(l))
      .map(l => l.replace(':', ''));
    expect(topLevelLocales).toEqual(['en', 'sv', 'nb', 'fi']);

    const originalLines = QASA_SHAPE.split('\n');
    const originalLineCount = originalLines.filter(l => l.length > 0).length;
    const actualLineCount = lines.filter(l => l.length > 0).length;
    expect(actualLineCount).toBe(originalLineCount + 3);

    const enBlockBefore = extractBlock(QASA_SHAPE, 'en');
    const enBlockAfter = extractBlock(raw, 'en');
    expect(enBlockAfter).toEqual(enBlockBefore);

    expect(raw).toMatch(/^ {2}headline: ''$/m);
    expect(raw).not.toMatch(/headline: ""/);
    expect(raw).not.toMatch(/^\t/m);

    expect(raw).toContain('cta_button: Granska och signera');
    expect(raw).toContain('cta_button: Gjennomgå og signer');
    expect(raw).toContain('cta_button: Tarkista ja allekirjoita');
  });

  it('single write to sv adds exactly one line; other locales unchanged verbatim', async () => {
    const sourceFilePath = multiLangPath;
    const before = await fs.readFile(multiLangPath, 'utf8');

    await updateTranslationFile(multiLangPath, { cta_button: 'Signera' }, 'sv', sourceFilePath, 'en');

    const after = await fs.readFile(multiLangPath, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');

    expect(afterLines.length).toBe(beforeLines.length + 1);

    const enBefore = extractBlock(before, 'en');
    const enAfter = extractBlock(after, 'en');
    expect(enAfter).toEqual(enBefore);

    const nbBefore = extractBlock(before, 'nb');
    const nbAfter = extractBlock(after, 'nb');
    expect(nbAfter).toEqual(nbBefore);

    const fiBefore = extractBlock(before, 'fi');
    const fiAfter = extractBlock(after, 'fi');
    expect(fiAfter).toEqual(fiBefore);

    expect(after).toContain('cta_button: Signera');
  });

  it('updating an existing key value does not reformat other values', async () => {
    const sourceFilePath = multiLangPath;

    await updateTranslationFile(multiLangPath, { subject: 'Du har blivit inbjuden' }, 'sv', sourceFilePath, 'en');

    const raw = await fs.readFile(multiLangPath, 'utf8');

    expect(raw).toMatch(/^ {2}subject: Invitation$/m);

    const nbBlock = extractBlock(raw, 'nb');
    expect(nbBlock).toContain("  subject: ''");
    expect(nbBlock).toContain("  headline: ''");

    const fiBlock = extractBlock(raw, 'fi');
    expect(fiBlock).toContain("  subject: ''");
    expect(fiBlock).toContain("  headline: ''");

    expect(raw).toMatch(/^ {2}subject: 'Du har blivit inbjuden'$/m);
  });

  it('source locale stays untouched when target-lang change matches English value', async () => {
    const sourceFilePath = multiLangPath;
    const initial = `---
en:
  greeting: Hello
sv:
  greeting: ''
`;
    await fs.writeFile(multiLangPath, initial, 'utf8');

    await updateTranslationFile(multiLangPath, { greeting: 'Hello' }, 'sv', sourceFilePath, 'en');

    const raw = await fs.readFile(multiLangPath, 'utf8');

    const enBlockBefore = extractBlock(initial, 'en');
    const enBlockAfter = extractBlock(raw, 'en');
    expect(enBlockAfter).toEqual(enBlockBefore);

    expect(raw).toContain('sv:');
    expect(raw).toMatch(/sv:\n {2}greeting: '?Hello'?/);
  });
});
