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

let collectTargetEditCandidates: any;

beforeAll(async () => {
  const module = await import('../../src/utils/target-edit-candidates.js');
  collectTargetEditCandidates = module.collectTargetEditCandidates;
});

const config = {
  projectId: 'test-project',
  sourceLocale: 'en',
  outputLocales: ['sv', 'nb'],
  translationFiles: { paths: ['config/locales/'] }
} as any;

const sourceFiles = [{ path: 'config/locales/en.yml', format: 'yml', locale: 'en' }];

const targetFilesByLocale = {
  sv: [{ path: 'config/locales/sv.yml', format: 'yml', locale: 'sv' }],
  nb: [{ path: 'config/locales/nb.yml', format: 'yml', locale: 'nb' }]
};

function edited(locale: string, key: string, oldValue: string, value: string, status = 'updated') {
  const path = `config/locales/${locale}.yml`;
  return {
    path,
    source_path: 'config/locales/en.yml',
    locale,
    format: 'yml',
    changes: [{ key, status, value, old_value: status === 'updated' ? oldValue : undefined }]
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

const baseFiles = {
  'en.yml': 'en:\n  profile:\n    published: "Your profile is published"\n',
  'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad"\n',
  'nb.yml': 'nb:\n  profile:\n    published: "Profilen din er publisert"\n'
};

beforeEach(() => {
  mockExecSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('collectTargetEditCandidates', () => {
  test('sends a key edited in one locale with the source and every locale\'s base and current value', () => {
    setupGit(baseFiles, { ...baseFiles, 'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n' });

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([{
      source_path: 'config/locales/en.yml',
      format: 'yml',
      key: 'profile.published',
      source_base: 'Your profile is published',
      source: 'Your profile is published',
      targets: [
        {
          locale: 'sv',
          target_path: 'config/locales/sv.yml',
          format: 'yml',
          writable: true,
          base: 'Din profil är publicerad',
          current: 'Din profil är publicerad nu'
        },
        {
          locale: 'nb',
          target_path: 'config/locales/nb.yml',
          format: 'yml',
          writable: true,
          base: 'Profilen din er publisert',
          current: 'Profilen din er publisert'
        }
      ]
    }]);
  });

  test('sends a key edited in several locales once', () => {
    setupGit(baseFiles, {
      ...baseFiles,
      'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n',
      'nb.yml': 'nb:\n  profile:\n    published: "Profilen din er publisert nå"\n'
    });

    const result = collectTargetEditCandidates(
      [
        edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu'),
        edited('nb', 'profile.published', 'Profilen din er publisert', 'Profilen din er publisert nå')
      ],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toHaveLength(1);
    expect(result[0].targets.map((target: any) => [target.locale, target.current])).toEqual([
      ['sv', 'Din profil är publicerad nu'],
      ['nb', 'Profilen din er publisert nå']
    ]);
  });

  test('sends a key whose only change is the source text, so a reverted trigger is still checked', () => {
    setupGit(baseFiles, { ...baseFiles, 'en.yml': 'en:\n  profile:\n    published: "Your profile is published now"\n' });

    const result = collectTargetEditCandidates(
      [{
        path: 'config/locales/en.yml',
        source_path: 'config/locales/en.yml',
        locale: 'en',
        format: 'yml',
        changes: [{
          key: 'profile.published',
          status: 'updated',
          value: 'Your profile is published now',
          old_value: 'Your profile is published',
          source_value: 'Your profile is published now'
        }]
      }],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([expect.objectContaining({
      key: 'profile.published',
      source_base: 'Your profile is published',
      source: 'Your profile is published now'
    })]);
    expect(result[0].targets).toHaveLength(2);
  });

  test('sends a locale without a base value with a null base, and leaves out a locale without a value', () => {
    setupGit(
      { ...baseFiles, 'nb.yml': 'nb:\n  other: "x"\n', 'fr.yml': 'fr:\n  other: "y"\n' },
      { ...baseFiles, 'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n', 'fr.yml': 'fr:\n  other: "y"\n' }
    );

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      { ...targetFilesByLocale, fr: [{ path: 'config/locales/fr.yml', format: 'yml', locale: 'fr' }] },
      { ...config, outputLocales: ['sv', 'nb', 'fr'] },
      false
    );

    expect(result[0].targets.map((target: any) => [target.locale, target.base])).toEqual([
      ['sv', 'Din profil är publicerad'],
      ['nb', null]
    ]);
  });

  test('leaves out a YAML source file without a locale root, whose writer would add one', () => {
    const unwrapped = 'profile:\n  published: "Your profile is published"\n';
    setupGit(
      { ...baseFiles, 'en.yml': unwrapped },
      { ...baseFiles, 'en.yml': unwrapped, 'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n' }
    );

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
  });

  test('keeps a target without a locale root for detecting the edit, marked as not writable', () => {
    setupGit(
      { ...baseFiles, 'nb.yml': 'profile:\n  published: "Profilen din er publisert"\n' },
      {
        ...baseFiles,
        'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n',
        'nb.yml': 'profile:\n  published: "Profilen din er publisert"\n'
      }
    );

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result[0].targets.map((target: any) => [target.locale, target.writable])).toEqual([['sv', true], ['nb', false]]);
  });

  test('leaves out keys added in this branch', () => {
    setupGit(
      { ...baseFiles, 'en.yml': 'en:\n  other: "x"\n' },
      { ...baseFiles, 'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n' }
    );

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
  });

  test('does not treat a filled-in empty value as an edit', () => {
    setupGit(baseFiles, baseFiles);

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', '', 'Din profil är publicerad', 'added')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
  });

  test('skips keys the ignore rules exclude', () => {
    setupGit(baseFiles, { ...baseFiles, 'sv.yml': 'sv:\n  profile:\n    published: "Din profil är publicerad nu"\n' });

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false,
      (key: string) => key.startsWith('profile.')
    );

    expect(result).toEqual([]);
  });

  test('does not look at PO files', () => {
    const result = collectTargetEditCandidates(
      [{
        path: 'locale/sv/LC_MESSAGES/django.po',
        source_path: 'locale/django.pot',
        locale: 'sv',
        format: 'po',
        changes: [{ key: 'Published', status: 'updated', value: 'Publicerad nu', old_value: 'Publicerad' }]
      }],
      [{ path: 'locale/django.pot', format: 'pot', locale: 'en' }],
      { sv: [{ path: 'locale/sv/LC_MESSAGES/django.po', format: 'po', locale: 'sv' }] },
      config,
      false
    );

    expect(result).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test('reads every locale of a multi-language file from that file', () => {
    const viewPath = 'app/views/profile/show.i18n.yml';
    const base = 'en:\n  published: "Your profile is published"\nsv:\n  published: "Din profil är publicerad"\nnb:\n  published: "Profilen din er publisert"\n';
    setupGit({ [viewPath]: base }, { [viewPath]: base.replace('publicerad"', 'publicerad nu"') });

    const result = collectTargetEditCandidates(
      [{
        path: viewPath,
        source_path: viewPath,
        locale: 'sv',
        format: 'yml',
        changes: [{ key: 'published', status: 'updated', value: 'Din profil är publicerad nu', old_value: 'Din profil är publicerad' }]
      }],
      [{ path: viewPath, format: 'yml', locale: 'en', multiLanguage: true }],
      {
        sv: [{ path: viewPath, format: 'yml', locale: 'sv', multiLanguage: true }],
        nb: [{ path: viewPath, format: 'yml', locale: 'nb', multiLanguage: true }]
      },
      config,
      false
    );

    expect(result).toEqual([{
      source_path: viewPath,
      format: 'yml',
      key: 'published',
      source_base: 'Your profile is published',
      source: 'Your profile is published',
      targets: [
        { locale: 'sv', target_path: viewPath, format: 'yml', writable: true, base: 'Din profil är publicerad', current: 'Din profil är publicerad nu' },
        { locale: 'nb', target_path: viewPath, format: 'yml', writable: true, base: 'Profilen din er publisert', current: 'Profilen din er publisert' }
      ]
    }]);
  });

  test('checks nothing when more than 250 keys were edited', () => {
    const keys = Array.from({ length: 251 }, (_, i) => `key_${i}`);
    const yaml = (locale: string, suffix: string) => `${locale}:\n${keys.map(key => `  ${key}: "${locale} ${key}${suffix}"`).join('\n')}\n`;
    setupGit(
      { 'en.yml': yaml('en', ''), 'sv.yml': yaml('sv', ''), 'nb.yml': yaml('nb', '') },
      { 'en.yml': yaml('en', ''), 'sv.yml': yaml('sv', ' nu'), 'nb.yml': yaml('nb', '') }
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = collectTargetEditCandidates(
      [{
        path: 'config/locales/sv.yml',
        source_path: 'config/locales/en.yml',
        locale: 'sv',
        format: 'yml',
        changes: keys.map(key => ({ key, status: 'updated', value: `sv ${key} nu`, old_value: `sv ${key}` }))
      }],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
    expect(String(log.mock.calls[0][0])).toContain('more than 250');
    log.mockRestore();
  });

  test('returns no candidates when the base branch cannot be resolved', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('unknown revision');
    });

    const result = collectTargetEditCandidates(
      [edited('sv', 'profile.published', 'Din profil är publicerad', 'Din profil är publicerad nu')],
      sourceFiles,
      targetFilesByLocale,
      config,
      false
    );

    expect(result).toEqual([]);
  });
});
