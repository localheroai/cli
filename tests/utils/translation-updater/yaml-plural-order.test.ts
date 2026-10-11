import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateYamlFile } from '../../../src/utils/translation-updater/yaml-handler.js';

describe('plural category order in written YAML', () => {
  let tempDir: string;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-test-'));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    warn.mockRestore();
  });

  it('writes a new plural group in CLDR order into an existing file', async () => {
    const filePath = path.join(tempDir, 'de.yml');
    fs.writeFileSync(filePath, 'de:\n  inbox:\n    title: Posteingang\n');

    await updateYamlFile(filePath, {
      'inbox.messages.other': '%{count} Nachrichten',
      'inbox.messages.one': '%{count} Nachricht'
    }, 'de');

    expect(fs.readFileSync(filePath, 'utf8')).toBe([
      'de:',
      '  inbox:',
      '    title: Posteingang',
      '    messages:',
      '      one: "%{count} Nachricht"',
      '      other: "%{count} Nachrichten"',
      ''
    ].join('\n'));
  });

  it('keeps a non-plural sibling where it was while ordering the categories around it', async () => {
    const filePath = path.join(tempDir, 'de.yml');
    fs.writeFileSync(filePath, 'de:\n  inbox:\n    title: Posteingang\n');

    await updateYamlFile(filePath, {
      'inbox.messages.other': 'Nachrichten',
      'inbox.messages.label': 'Anzahl',
      'inbox.messages.few': 'Nachrichten',
      'inbox.messages.one': 'Nachricht'
    }, 'de');

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(4).map(line => line.trim().split(':')[0]);
    expect(lines.slice(0, 4)).toEqual(['one', 'label', 'few', 'other']);
  });

  it('writes a new plural group in CLDR order when creating the file', async () => {
    const filePath = path.join(tempDir, 'de.yml');

    await updateYamlFile(filePath, {
      'inbox.messages.other': '%{count} Nachrichten',
      'inbox.messages.one': '%{count} Nachricht'
    }, 'de');

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content.indexOf('one:')).toBeLessThan(content.indexOf('other:'));
  });

  it('appends categories missing from an existing group after it, leaving existing lines untouched', async () => {
    const filePath = path.join(tempDir, 'pl.yml');
    const original = [
      'pl:',
      '  inbox:',
      '    messages:',
      '      one: "%{count} wiadomość"',
      '      other: "%{count} wiadomości"',
      '    title: Skrzynka',
      ''
    ].join('\n');
    fs.writeFileSync(filePath, original);

    await updateYamlFile(filePath, {
      'inbox.messages.many': '%{count} wiadomości',
      'inbox.messages.few': '%{count} wiadomości'
    }, 'pl');

    expect(fs.readFileSync(filePath, 'utf8')).toBe([
      'pl:',
      '  inbox:',
      '    messages:',
      '      one: "%{count} wiadomość"',
      '      other: "%{count} wiadomości"',
      '      few: "%{count} wiadomości"',
      '      many: "%{count} wiadomości"',
      '    title: Skrzynka',
      ''
    ].join('\n'));
  });
});
