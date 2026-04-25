import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../../src/utils/translation-updater/index.js';
import { resetPathSerializer } from '../../../src/utils/translation-updater/path-serializer.js';

const INITIAL_CONTENT = `---
en:
  headline: "You've been invited"
  subject: 'Sign your invitation'
  body: 'Review the document and confirm with a single click.'
  cta_button: 'Review and sign'
sv:
  headline: 'Du har blivit inbjuden'
  subject: 'Signera din inbjudan'
  body: 'Granska dokumentet och bekräfta med ett klick.'
nb:
  headline: 'Du har blitt invitert'
  subject: 'Signer invitasjonen'
  body: 'Gjennomgå dokumentet og bekreft med ett klikk.'
fi:
  headline: 'Sinut on kutsuttu'
  subject: 'Allekirjoita kutsu'
  body: 'Tarkista asiakirja ja vahvista yhdellä napsautuksella.'
`;

describe('concurrent writes to the same multi-language file', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    resetPathSerializer();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localhero-concurrent-'));
    filePath = path.join(tempDir, 'invite.i18n.yml');
    await fs.writeFile(filePath, INITIAL_CONTENT, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('three concurrent updateTranslationFile calls on same path all land in the final file', async () => {
    await Promise.all([
      updateTranslationFile(filePath, { cta_button: 'Granska och signera' }, 'sv', filePath, 'en'),
      updateTranslationFile(filePath, { cta_button: 'Gå gjennom og signer' }, 'nb', filePath, 'en'),
      updateTranslationFile(filePath, { cta_button: 'Tarkista ja allekirjoita' }, 'fi', filePath, 'en'),
    ]);

    const after = await fs.readFile(filePath, 'utf8');

    expect(after).toContain('Granska och signera');
    expect(after).toContain('Gå gjennom og signer');
    expect(after).toContain('Tarkista ja allekirjoita');

    const svBlock = after.match(/^sv:[\s\S]*?^(?=[a-z]{2}:)/m)?.[0] ?? '';
    const nbBlock = after.match(/^nb:[\s\S]*?^(?=[a-z]{2}:)/m)?.[0] ?? '';
    const fiBlock = after.match(/^fi:[\s\S]*$/m)?.[0] ?? '';
    expect(svBlock).toContain('Granska och signera');
    expect(nbBlock).toContain('Gå gjennom og signer');
    expect(fiBlock).toContain('Tarkista ja allekirjoita');
  });

  it('path-serialized writes to different paths still run in parallel', async () => {
    const file2 = path.join(tempDir, 'other.i18n.yml');
    await fs.writeFile(file2, "en:\n  greeting: 'Hello'\nsv:\n  greeting: 'Hej'\n", 'utf8');

    await Promise.all([
      updateTranslationFile(filePath, { cta_button: 'sv-translation' }, 'sv', filePath, 'en'),
      updateTranslationFile(file2, { greeting: 'Hej världen' }, 'sv', file2, 'en'),
    ]);

    const file1After = await fs.readFile(filePath, 'utf8');
    const file2After = await fs.readFile(file2, 'utf8');

    expect(file1After).toContain('sv-translation');
    expect(file2After).toContain('Hej världen');
  });
});
