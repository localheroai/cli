import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { keepAlignedCellsOnDisk } from '../../src/utils/aligned-values-on-disk.js';

describe('keepAlignedCellsOnDisk', () => {
  let dir: string;
  let log: jest.Mock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aligned-'));
    log = jest.fn();
    writeFileSync(
      path.join(dir, 'en.yml'),
      'en:\n  title: "Your profile"\n  profile:\n    title: "Your profile"\n    hint: "Your profile"\n    gone: "Your profile"\n'
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function cell(key: string, value: string, targetPath: string, locale = 'fr', sourcePath = path.join(dir, 'en.yml')) {
    return {
      locale,
      source_path: sourcePath,
      target_path: targetPath,
      format: path.extname(targetPath).slice(1),
      key,
      previous_source: 'Profile!',
      source: 'Your profile',
      target_base: 'Profil !',
      target_current: 'Profil !',
      value
    };
  }

  it('drops cells whose value was changed or removed after writing', () => {
    const target = path.join(dir, 'fr.yml');
    writeFileSync(target, 'fr:\n  profile:\n    title: "Votre profil"\n    hint: "Astuce reformatée"\n');

    const kept = keepAlignedCellsOnDisk([
      cell('profile.title', 'Votre profil', target),
      cell('profile.hint', 'Astuce', target),
      cell('profile.gone', 'Parti', target)
    ], 'en', { log });

    expect(kept.map((c) => c.key)).toEqual(['profile.title']);
    expect(String(log.mock.calls[0][0])).toContain('2 aligned values changed after they were written');
  });

  it('reads the locale subtree of a multi-language file', () => {
    const view = path.join(dir, 'show.i18n.yml');
    writeFileSync(view, 'en:\n  title: "Your profile"\nfr:\n  title: "Votre profil"\nde:\n  title: "Profil"\n');

    const kept = keepAlignedCellsOnDisk([
      cell('title', 'Votre profil', view, 'fr', view),
      cell('title', 'Dein Profil', view, 'de', view)
    ], 'en', { log });

    expect(kept.map((c) => c.locale)).toEqual(['fr']);
  });

  it('reads JSON files', () => {
    const target = path.join(dir, 'fr.json');
    writeFileSync(target, JSON.stringify({ profile: { title: 'Votre profil' } }));

    expect(keepAlignedCellsOnDisk([cell('profile.title', 'Votre profil', target)], 'en', { log })).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('drops the cells of a file that can no longer be read', () => {
    const kept = keepAlignedCellsOnDisk([cell('title', 'Votre profil', path.join(dir, 'deleted.yml'))], 'en', { log });

    expect(kept).toEqual([]);
  });

  it('drops cells whose source text changed after alignment', () => {
    const target = path.join(dir, 'fr.yml');
    writeFileSync(target, 'fr:\n  profile:\n    title: "Votre profil"\n    hint: "Votre profil"\n');
    writeFileSync(path.join(dir, 'en.yml'), 'en:\n  profile:\n    title: "Your profile"\n    hint: "Your  profile"\n');

    const kept = keepAlignedCellsOnDisk([
      cell('profile.title', 'Votre profil', target),
      cell('profile.hint', 'Votre profil', target)
    ], 'en', { log });

    expect(kept.map((c) => c.key)).toEqual(['profile.title']);
  });
});
