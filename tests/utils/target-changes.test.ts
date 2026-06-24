import { jest } from '@jest/globals';

const mockExecSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync
}));

import * as actualFs from 'fs';

jest.unstable_mockModule('fs', () => ({
  ...actualFs,
  readFileSync: mockReadFileSync
}));

let detectTargetChanges: any;

beforeAll(async () => {
  const module = await import('../../src/utils/target-changes.js');
  detectTargetChanges = module.detectTargetChanges;
});

const config = {
  projectId: 'test-project',
  sourceLocale: 'en',
  outputLocales: ['ja_easy'],
  translationFiles: { paths: ['config/locales/'] }
} as any;

const sourceFiles = [
  { path: 'config/locales/en.yml', format: 'yml', locale: 'en' }
];

const targetFilesByLocale = {
  ja_easy: [{ path: 'config/locales/ja_easy.yml', format: 'yml', locale: 'ja_easy' }]
};

function setupGitMock({ oldContent }: { oldContent: string | null }) {
  mockExecSync.mockImplementation((cmd: any) => {
    if (cmd === 'git rev-parse --git-dir') return '';
    if (String(cmd).includes('git rev-parse --verify')) return '';
    if (String(cmd).includes('git merge-base')) return 'abc123\n';
    if (String(cmd).includes('git show')) {
      if (oldContent === null) throw new Error('does not exist');
      return oldContent;
    }
    throw new Error(`Unexpected git command: ${cmd}`);
  });
}

beforeEach(() => {
  mockExecSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('detectTargetChanges', () => {
  test('detects updated and added values with old values attached', () => {
    setupGitMock({
      oldContent: 'ja_easy:\n  greeting: "こんにちは"\n  farewell: "さようなら"\n'
    });
    mockReadFileSync.mockReturnValue(
      'ja_easy:\n  greeting: "やあ"\n  farewell: "さようなら"\n  hint: "ヒント"\n'
    );

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    expect(result).toEqual([
      {
        path: 'config/locales/ja_easy.yml',
        source_path: 'config/locales/en.yml',
        locale: 'ja_easy',
        format: 'yml',
        changes: [
          { key: 'greeting', status: 'updated', value: 'やあ', old_value: 'こんにちは' },
          { key: 'hint', status: 'added', value: 'ヒント' }
        ]
      }
    ]);
  });

  test('returns empty array when nothing changed', () => {
    const content = 'ja_easy:\n  greeting: "こんにちは"\n';
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toEqual([]);
  });

  test('treats a file missing at the base ref as all-added', () => {
    setupGitMock({ oldContent: null });
    mockReadFileSync.mockReturnValue('ja_easy:\n  greeting: "やあ"\n');

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    expect(result![0].changes).toEqual([
      { key: 'greeting', status: 'added', value: 'やあ' }
    ]);
  });

  test('skips empty and non-string values', () => {
    setupGitMock({ oldContent: 'ja_easy:\n  count: 1\n' });
    mockReadFileSync.mockReturnValue('ja_easy:\n  count: 2\n  blank: ""\n');

    expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toEqual([]);
  });

  test('treats a null placeholder replaced by a string as added', () => {
    // Untranslated YAML keys are commonly null placeholders; a reviewer filling
    // one in must be detected, not silently dropped.
    setupGitMock({ oldContent: 'ja_easy:\n  greeting:\n  farewell: "さようなら"\n' });
    mockReadFileSync.mockReturnValue('ja_easy:\n  greeting: "こんにちは"\n  farewell: "さようなら"\n');

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    expect(result![0].changes).toEqual([
      { key: 'greeting', status: 'added', value: 'こんにちは' }
    ]);
  });

  test('multi-language files use their own path as source_path', () => {
    setupGitMock({
      oldContent: 'en:\n  greeting: "Hello"\nsv:\n  greeting: "Hej"\n'
    });
    mockReadFileSync.mockReturnValue('en:\n  greeting: "Hello"\nsv:\n  greeting: "Tjena"\n');

    const result = detectTargetChanges(
      [{ path: 'config/locales/shared.yml', format: 'yml', locale: 'en', multiLanguage: true }] as any,
      { sv: [{ path: 'config/locales/shared.yml', format: 'yml', locale: 'sv', multiLanguage: true }] } as any,
      { ...config, outputLocales: ['sv'] },
      false
    );

    expect(result).toEqual([
      {
        path: 'config/locales/shared.yml',
        source_path: 'config/locales/shared.yml',
        locale: 'sv',
        format: 'yml',
        changes: [
          { key: 'greeting', status: 'updated', value: 'Tjena', old_value: 'Hej' }
        ]
      }
    ]);
  });

  test('returns null when git is unavailable', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git: command not found');
    });

    expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toBeNull();
  });
});
