import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

describe('JSON multi-language sequential writes', () => {
  let tempDir: string;
  let multiLangPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-multi-'));
    multiLangPath = path.join(tempDir, 'invite.i18n.json');
    const initial = {
      en: { subject: "You've been invited", title: 'Sign your document' },
      sv: { subject: 'Du har blivit inbjuden', title: 'Signera dokumentet' },
      nb: { subject: 'Du har blitt invitert', title: 'Signer dokumentet ditt' },
      fi: { subject: 'Sinut on kutsuttu', title: 'Allekirjoita asiakirjasi' }
    };
    await fs.writeFile(multiLangPath, JSON.stringify(initial, null, 2), 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('sequential updates to three target locales preserve the source locale untouched', async () => {
    const sourceFilePath = multiLangPath;

    await updateTranslationFile(multiLangPath, { cta_button: 'Granska och signera' }, 'sv', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { cta_button: 'Gjennomgå og signer' }, 'nb', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { cta_button: 'Tarkista ja allekirjoita' }, 'fi', sourceFilePath, 'en');

    const final = JSON.parse(await fs.readFile(multiLangPath, 'utf8'));

    expect(Object.keys(final).sort()).toEqual(['en', 'fi', 'nb', 'sv']);

    expect(final.en).toEqual({ subject: "You've been invited", title: 'Sign your document' });

    expect(final.sv).toEqual({
      subject: 'Du har blivit inbjuden',
      title: 'Signera dokumentet',
      cta_button: 'Granska och signera'
    });
    expect(final.nb).toEqual({
      subject: 'Du har blitt invitert',
      title: 'Signer dokumentet ditt',
      cta_button: 'Gjennomgå og signer'
    });
    expect(final.fi).toEqual({
      subject: 'Sinut on kutsuttu',
      title: 'Allekirjoita asiakirjasi',
      cta_button: 'Tarkista ja allekirjoita'
    });
  });

  it('preserves the top-level locale insertion order after sequential writes', async () => {
    const sourceFilePath = multiLangPath;
    await updateTranslationFile(multiLangPath, { extra: 'x' }, 'sv', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { extra: 'x' }, 'nb', sourceFilePath, 'en');
    await updateTranslationFile(multiLangPath, { extra: 'x' }, 'fi', sourceFilePath, 'en');

    const rawAfter = await fs.readFile(multiLangPath, 'utf8');
    const parsedAfter = JSON.parse(rawAfter);
    expect(Object.keys(parsedAfter)).toEqual(['en', 'sv', 'nb', 'fi']);
  });

  it('does not touch other locales when updating one, even when adding a new key', async () => {
    const sourceFilePath = multiLangPath;
    const before = JSON.parse(await fs.readFile(multiLangPath, 'utf8'));

    await updateTranslationFile(multiLangPath, { cta: 'Signera' }, 'sv', sourceFilePath, 'en');

    const after = JSON.parse(await fs.readFile(multiLangPath, 'utf8'));
    expect(after.en).toEqual(before.en);
    expect(after.nb).toEqual(before.nb);
    expect(after.fi).toEqual(before.fi);
    expect(after.sv).toEqual({ ...before.sv, cta: 'Signera' });
  });
});

describe('JSON handler with flat files that have 2-letter object keys', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-flat-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not wrap a flat file with a single 2-letter object-valued key when the target locale is absent', async () => {
    const filePath = path.join(tempDir, 'sv.json');
    const initial = {
      id: { type: 'uuid', value: 'abc' },
      greeting: 'Hej'
    };
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8');

    await updateTranslationFile(filePath, { farewell: 'Hej då' }, 'sv', filePath, 'en');

    const after = JSON.parse(await fs.readFile(filePath, 'utf8'));

    expect(after).toEqual({
      id: { type: 'uuid', value: 'abc' },
      greeting: 'Hej',
      farewell: 'Hej då'
    });
    expect(after.sv).toBeUndefined();
  });

  it('wraps the new locale when 2+ locale-shape sibling entries already exist', async () => {
    const filePath = path.join(tempDir, 'greet.i18n.json');
    const initial = {
      en: { greeting: 'Hello' },
      sv: { greeting: 'Hej' }
    };
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8');

    await updateTranslationFile(filePath, { greeting: 'Hei' }, 'nb', filePath, 'en');

    const after = JSON.parse(await fs.readFile(filePath, 'utf8'));

    expect(Object.keys(after).sort()).toEqual(['en', 'nb', 'sv']);
    expect(after.nb).toEqual({ greeting: 'Hei' });
  });
});
