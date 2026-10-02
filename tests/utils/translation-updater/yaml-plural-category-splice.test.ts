import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateYamlFile } from '../../../src/utils/translation-updater/yaml-handler.js';

describe('writing target-only plural categories (#636)', () => {
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

  it('splices few and many beneath a commented plural mapping, keeping the comments', async () => {
    const filePath = path.join(tempDir, 'pl.yml');
    fs.writeFileSync(filePath, [
      'pl:',
      '  # Shown on the board header',
      '  board:',
      '    overdue:',
      '      # count=1',
      '      one: "%{count} zaległe zadanie"',
      '      other: "%{count} zaległego zadania"',
      ''
    ].join('\n'));

    await updateYamlFile(filePath, {
      'board.overdue.few': '%{count} zaległe zadania',
      'board.overdue.many': '%{count} zaległych zadań'
    }, 'pl');

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('  # Shown on the board header\n');
    expect(content).toContain('      # count=1\n');
    expect(content).toContain('few: "%{count} zaległe zadania"');
    expect(content).toContain('many: "%{count} zaległych zadań"');
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the file when it has to rewrite the whole document', async () => {
    const filePath = path.join(tempDir, 'pl.yml');
    fs.writeFileSync(filePath, 'pl:\n  board:\n    intro: |\n      Tablica\n');

    await updateYamlFile(filePath, { 'board.intro': 'Tablica zadań' }, 'pl');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(filePath));
  });
});
