import { jest } from '@jest/globals';

const mockExecSync = jest.fn<any>();
const mockReadFileSync = jest.fn<any>();

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync
}));

import * as actualFs from 'fs';

jest.unstable_mockModule('fs', () => ({
  ...actualFs,
  readFileSync: mockReadFileSync
}));

let collectAlignmentCandidates: any;

beforeAll(async () => {
  const module = await import('../../src/utils/alignment-candidates.js');
  collectAlignmentCandidates = module.collectAlignmentCandidates;
});

const config = {
  projectId: 'test-project',
  sourceLocale: 'en',
  outputLocales: ['fr', 'de'],
  translationFiles: { paths: ['config/locales/'] }
} as any;

const sourceFiles = [{ path: 'config/locales/en.yml', format: 'yml', locale: 'en' }];

const targetFilesByLocale = {
  fr: [{ path: 'config/locales/fr.yml', format: 'yml', locale: 'fr' }],
  de: [{ path: 'config/locales/de.yml', format: 'yml', locale: 'de' }]
};

function reworded(key: string, oldValue: string, value: string, path = 'config/locales/en.yml') {
  return {
    path,
    source_path: path,
    locale: 'en',
    format: 'yml',
    changes: [{ key, status: 'updated', value, old_value: oldValue, source_value: value }]
  };
}

function setupGit(oldContentByPath: Record<string, string | null>, newContentByPath: Record<string, string>) {
  mockExecSync.mockImplementation((cmd: any) => {
    const command = String(cmd);
    if (command === 'git rev-parse --git-dir') return '';
    if (command.includes('git rev-parse --verify')) return '';
    if (command.includes('git merge-base')) return 'abc123\n';
    if (command.includes('git show')) {
      const matched = Object.keys(oldContentByPath).find(p => command.includes(p));
      const content = matched !== undefined ? oldContentByPath[matched] : null;
      if (content === null) throw new Error('does not exist');
      return content;
    }
    throw new Error(`Unexpected git command: ${command}`);
  });
  mockReadFileSync.mockImplementation((filePath: any) => {
    const matched = Object.keys(newContentByPath).find(p => String(filePath).includes(p));
    if (matched !== undefined) return newContentByPath[matched];
    throw new Error(`Unexpected readFileSync path: ${filePath}`);
  });
}

beforeEach(() => {
  mockExecSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('collectAlignmentCandidates', () => {
  test('pairs each reworded source key with every target locale, with base and current target values', () => {
    setupGit(
      {
        'fr.yml': 'fr:\n  profile:\n    title: "Profil !"\n',
        'de.yml': 'de:\n  profile:\n    title: "Profil!"\n'
      },
      {
        'fr.yml': 'fr:\n  profile:\n    title: "Profil !"\n',
        'de.yml': 'de:\n  profile:\n    title: "Dein Profil"\n'
      }
    );

    const result = collectAlignmentCandidates(
      [reworded('profile.title', 'Profile!', 'Your profile')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([
      {
        locale: 'fr',
        source_path: 'config/locales/en.yml',
        target_path: 'config/locales/fr.yml',
        format: 'yml',
        key: 'profile.title',
        previous_source: 'Profile!',
        source: 'Your profile',
        target_base: 'Profil !',
        target_current: 'Profil !'
      },
      {
        locale: 'de',
        source_path: 'config/locales/en.yml',
        target_path: 'config/locales/de.yml',
        format: 'yml',
        key: 'profile.title',
        previous_source: 'Profile!',
        source: 'Your profile',
        target_base: 'Profil!',
        target_current: 'Dein Profil'
      }
    ]);
  });

  test('uses the same file as the target for multi-language files', () => {
    const viewPath = 'app/views/profile/show.i18n.yml';
    const content = 'en:\n  title: "Your profile"\nfr:\n  title: "Profil"\n';
    setupGit({ [viewPath]: 'en:\n  title: "Profile!"\nfr:\n  title: "Profil"\n' }, { [viewPath]: content });

    const result = collectAlignmentCandidates(
      [reworded('title', 'Profile!', 'Your profile', viewPath)],
      [{ path: viewPath, format: 'yml', locale: 'en', multiLanguage: true }],
      { fr: [{ path: viewPath, format: 'yml', locale: 'fr', multiLanguage: true }] },
      { ...config, outputLocales: ['fr'] },
      false
    );

    expect(result).toEqual([
      expect.objectContaining({
        locale: 'fr',
        source_path: viewPath,
        target_path: viewPath,
        key: 'title',
        target_base: 'Profil',
        target_current: 'Profil'
      })
    ]);
  });

  test('sends each key once when overlapping paths list a multi-language file twice', () => {
    const viewPath = 'config/locales/multi/welcome.yml';
    setupGit(
      { [viewPath]: 'en:\n  title: "Welcome"\nfr:\n  title: "Bienvenue"\n' },
      { [viewPath]: 'en:\n  title: "Welcome"\n  tip: "Invite your team"\nfr:\n  title: "Bienvenue"\n  tip: "Invitez votre équipe"\n' }
    );
    const file = { path: viewPath, format: 'yml', locale: 'en', multiLanguage: true };
    const target = { path: viewPath, format: 'yml', locale: 'fr', multiLanguage: true };

    const result = collectAlignmentCandidates([], [file, { ...file }], { fr: [target, { ...target }] }, { ...config, outputLocales: ['fr'] }, false);

    expect(result.map((c: any) => [c.locale, c.key])).toEqual([['fr', 'tip']]);
  });

  test('passes a null target_base when the key is new in the target', () => {
    setupGit(
      { 'fr.yml': 'fr:\n  other: "Autre"\n', 'de.yml': null },
      { 'fr.yml': 'fr:\n  other: "Autre"\n  title: "Profil"\n', 'de.yml': 'de:\n  title: "Profil"\n' }
    );

    const result = collectAlignmentCandidates(
      [reworded('title', 'Profile!', 'Your profile')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result.map((c: any) => [c.locale, c.target_base])).toEqual([['fr', null], ['de', null]]);
  });

  test('leaves keys the target does not have to the missing-key flow', () => {
    setupGit(
      { 'fr.yml': 'fr:\n  title: "Profil"\n' },
      { 'fr.yml': 'fr:\n  other: "Autre"\n' }
    );

    const result = collectAlignmentCandidates(
      [reworded('title', 'Profile!', 'Your profile')],
      sourceFiles,
      { fr: targetFilesByLocale.fr },
      config,
      false
    );

    expect(result).toEqual([]);
  });

  test('pairs each key added in this branch with every target locale that already translates it', () => {
    setupGit(
      {
        'en.yml': 'en:\n  profile:\n    title: "Profile"\n',
        'fr.yml': 'fr:\n  profile:\n    title: "Profil"\n',
        'de.yml': 'de:\n  profile:\n    title: "Profil"\n'
      },
      {
        'en.yml': 'en:\n  profile:\n    title: "Profile"\n    hint: "Add a photo"\n',
        'fr.yml': 'fr:\n  profile:\n    title: "Profil"\n    hint: "Ajoutez une photo"\n',
        'de.yml': 'de:\n  profile:\n    title: "Profil"\n    hint: "Foto hinzufügen"\n'
      }
    );

    const result = collectAlignmentCandidates([], sourceFiles, targetFilesByLocale, config, false);

    expect(result).toEqual([
      {
        locale: 'fr',
        source_path: 'config/locales/en.yml',
        target_path: 'config/locales/fr.yml',
        format: 'yml',
        key: 'profile.hint',
        previous_source: null,
        source: 'Add a photo',
        target_base: null,
        target_current: 'Ajoutez une photo'
      },
      {
        locale: 'de',
        source_path: 'config/locales/en.yml',
        target_path: 'config/locales/de.yml',
        format: 'yml',
        key: 'profile.hint',
        previous_source: null,
        source: 'Add a photo',
        target_base: null,
        target_current: 'Foto hinzufügen'
      }
    ]);
  });

  test('leaves added keys out when there are too many to check, and still aligns rewordings', () => {
    const lines = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `    key${i}: "${prefix} ${i}"\n`).join('');
    setupGit(
      {
        'en.yml': 'en:\n  title: "Profile"\n  added:\n',
        'fr.yml': 'fr:\n  title: "Profil"\n',
        'de.yml': 'de:\n  title: "Profil"\n'
      },
      {
        'en.yml': `en:\n  title: "Your profile"\n  added:\n${lines('Text', 251)}`,
        'fr.yml': `fr:\n  title: "Profil"\n  added:\n${lines('Texte', 251)}`,
        'de.yml': `de:\n  title: "Profil"\n  added:\n${lines('Text', 251)}`
      }
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = collectAlignmentCandidates([reworded('title', 'Profile', 'Your profile')], sourceFiles, targetFilesByLocale, config, false);

    expect(result.map((c: any) => [c.locale, c.key])).toEqual([['fr', 'title'], ['de', 'title']]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('251 keys added in this branch'));
    log.mockRestore();
  });

  test('pairs reworded keys before keys added in the same file', () => {
    setupGit(
      { 'en.yml': 'en:\n  title: "Profile!"\n', 'fr.yml': 'fr:\n  title: "Profil !"\n' },
      {
        'en.yml': 'en:\n  title: "Your profile"\n  hint: "Add a photo"\n',
        'fr.yml': 'fr:\n  title: "Profil !"\n  hint: "Ajoutez une photo"\n'
      }
    );

    const result = collectAlignmentCandidates(
      [reworded('title', 'Profile!', 'Your profile')],
      sourceFiles,
      { fr: targetFilesByLocale.fr },
      { ...config, outputLocales: ['fr'] },
      false
    );

    expect(result.map((c: any) => [c.key, c.previous_source, c.target_base])).toEqual([
      ['title', 'Profile!', 'Profil !'],
      ['hint', null, null]
    ]);
  });

  test('leaves added keys without a translation to the missing-key flow', () => {
    setupGit(
      { 'en.yml': 'en:\n  title: "Profile"\n', 'fr.yml': 'fr:\n  title: "Profil"\n', 'de.yml': 'de:\n  title: "Profil"\n' },
      {
        'en.yml': 'en:\n  title: "Profile"\n  hint: "Add a photo"\n',
        'fr.yml': 'fr:\n  title: "Profil"\n',
        'de.yml': 'de:\n  title: "Profil"\n  hint: ""\n'
      }
    );

    const result = collectAlignmentCandidates([], sourceFiles, targetFilesByLocale, config, false);

    expect(result).toEqual([]);
  });

  test('skips added keys the ignore rules exclude', () => {
    setupGit(
      { 'en.yml': 'en:\n  title: "Profile"\n', 'fr.yml': 'fr:\n  title: "Profil"\n' },
      {
        'en.yml': 'en:\n  title: "Profile"\n  hint: "Add a photo"\n  admin:\n    note: "Internal"\n',
        'fr.yml': 'fr:\n  title: "Profil"\n  hint: "Ajoutez une photo"\n  admin:\n    note: "Interne"\n'
      }
    );

    const result = collectAlignmentCandidates(
      [],
      sourceFiles,
      { fr: targetFilesByLocale.fr },
      { ...config, outputLocales: ['fr'] },
      false,
      (key: string) => key.startsWith('admin.')
    );

    expect(result.map((c: any) => c.key)).toEqual(['hint']);
  });

  test('does not look for added keys in PO source files', () => {
    const result = collectAlignmentCandidates(
      [],
      [{ path: 'locale/en.po', format: 'po', locale: 'en' }],
      { fr: [{ path: 'locale/fr.po', format: 'po', locale: 'fr' }] },
      { ...config, outputLocales: ['fr'] },
      false
    );

    expect(result).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining('git show'), expect.anything());
  });

  test('ignores target-file changes, PO files and fills of empty source values', () => {
    setupGit({ 'en.yml': 'en:\n  subtitle: ""\n' }, { 'en.yml': 'en:\n  subtitle: "New subtitle"\n' });

    const result = collectAlignmentCandidates(
      [
        { ...reworded('title', 'Profile!', 'Your profile'), path: 'config/locales/fr.yml', locale: 'fr' },
        { ...reworded('title', 'Profile', 'Your profile', 'locale/en.po'), format: 'po' },
        reworded('subtitle', '', 'New subtitle')
      ],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining('fr.yml'), expect.anything());
  });

  test('returns no candidates when the base branch cannot be resolved', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a valid ref');
    });

    const result = collectAlignmentCandidates(
      [reworded('title', 'Profile!', 'Your profile')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
  });
});
