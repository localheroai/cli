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

type OldContentMap = Record<string, string | null>;

function setupGitMock({ oldContent }: { oldContent: string | null | OldContentMap }) {
  mockExecSync.mockImplementation((cmd: any) => {
    if (cmd === 'git rev-parse --git-dir') return '';
    if (String(cmd).includes('git rev-parse --verify')) return '';
    if (String(cmd).includes('git merge-base')) return 'abc123\n';
    if (String(cmd).includes('git show')) {
      if (typeof oldContent === 'object' && oldContent !== null) {
        const matchedPath = Object.keys(oldContent).find(p => String(cmd).includes(p));
        const content = matchedPath !== undefined ? oldContent[matchedPath] : null;
        if (content === null) throw new Error('does not exist');
        return content;
      }
      if (oldContent === null) throw new Error('does not exist');
      return oldContent;
    }
    throw new Error(`Unexpected git command: ${cmd}`);
  });
}

function setupReadMock(contentByPath: Record<string, string>) {
  mockReadFileSync.mockImplementation((filePath: any) => {
    const matchedPath = Object.keys(contentByPath).find(p => String(filePath).includes(p));
    if (matchedPath !== undefined) return contentByPath[matchedPath];
    throw new Error(`Unexpected readFileSync path: ${filePath}`);
  });
}

beforeEach(() => {
  mockExecSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('detectTargetChanges', () => {
  test('detects updated and added values with old values attached', () => {
    const enContent = 'en:\n  title: "App"\n';
    setupGitMock({
      oldContent: {
        'en.yml': enContent,
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n  farewell: "さようなら"\n'
      }
    });
    setupReadMock({
      'en.yml': enContent,
      'ja_easy.yml': 'ja_easy:\n  greeting: "やあ"\n  farewell: "さようなら"\n  hint: "ヒント"\n'
    });

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
    const oldShared = 'en:\n  greeting: "Hello"\nsv:\n  greeting: "Hej"\n';
    const newShared = 'en:\n  greeting: "Hello"\nsv:\n  greeting: "Tjena"\n';
    setupGitMock({ oldContent: { 'shared.yml': oldShared } });
    setupReadMock({ 'shared.yml': newShared });

    const result = detectTargetChanges(
      [{ path: 'config/locales/shared.yml', format: 'yml', locale: 'en', multiLanguage: true }] as any,
      { sv: [{ path: 'config/locales/shared.yml', format: 'yml', locale: 'sv', multiLanguage: true }] } as any,
      { ...config, outputLocales: ['sv'] },
      false
    );

    const targetEntry = result?.find(r => r.locale === 'sv');
    expect(targetEntry).toEqual({
      path: 'config/locales/shared.yml',
      source_path: 'config/locales/shared.yml',
      locale: 'sv',
      format: 'yml',
      changes: [
        { key: 'greeting', status: 'updated', value: 'Tjena', old_value: 'Hej', source_value: 'Hello' }
      ]
    });
  });

  test('returns null when git is unavailable', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git: command not found');
    });

    expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toBeNull();
  });
});

describe('detectTargetChanges — ingestion hardening', () => {
  const manyKeys = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `  k${i}: "${prefix}${i}"`).join('\n');

  test('git failures other than a missing base file do not fabricate additions', () => {
    mockExecSync.mockImplementation((cmd: any) => {
      if (cmd === 'git rev-parse --git-dir') return '';
      if (String(cmd).includes('git rev-parse --verify')) return '';
      if (String(cmd).includes('git merge-base')) return 'abc123\n';
      if (String(cmd).includes('git show')) {
        if (String(cmd).includes('ja_easy.yml')) throw new Error('fatal: unable to read tree abc123');
        return 'en:\n  greeting: "Hello"\n';
      }
      throw new Error(`Unexpected git command: ${cmd}`);
    });
    setupReadMock({
      'en.yml': 'en:\n  greeting: "Hello"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
    });

    // The unchanged ja_easy greeting must not be reported as added just because
    // git failed — the backend would trust it and create/stage from it.
    expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toEqual([]);
  });

  test('an unpaired target file does not consume the ingestion cap', () => {
    const pairedAndUnpaired = {
      ja_easy: [
        { path: 'config/locales/extra/notes.yml', format: 'yml', locale: 'ja_easy' },
        { path: 'config/locales/ja_easy.yml', format: 'yml', locale: 'ja_easy' }
      ]
    } as any;
    setupGitMock({ oldContent: { 'en.yml': 'en:\n  title: "App"\n' } });
    setupReadMock({
      'en.yml': 'en:\n  title: "App"\n',
      'extra/notes.yml': `ja_easy:\n${manyKeys('n', 600)}\n`,
      'ja_easy.yml': `ja_easy:\n${manyKeys('j', 600)}\n`
    });

    const result = detectTargetChanges(sourceFiles, pairedAndUnpaired, config, false);

    // 600 changes in the unpaired notes.yml must not push the paired file over the cap.
    const paired = result?.find(r => r.path === 'config/locales/ja_easy.yml');
    expect(paired?.changes).toHaveLength(600);
  });

  test('cap suppression is reported without verbose', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      setupGitMock({ oldContent: { 'en.yml': 'en:\n  title: "App"\n' } });
      setupReadMock({
        'en.yml': 'en:\n  title: "App"\n',
        'ja_easy.yml': `ja_easy:\n${manyKeys('j', 1100)}\n`
      });

      expect(detectTargetChanges(sourceFiles, targetFilesByLocale, config, false)).toBeNull();
      const logged = spy.mock.calls.map(args => String(args[0])).join('\n');
      expect(logged).toContain('more than 1000 changed values');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('detectTargetChanges — source_value attachment', () => {
  test('attaches source_value to target changes whose key exists in the source file', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  greeting: "Hello"\n  cta: "Sign up"\n',
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  greeting: "Hello"\n  cta: "Sign up"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n  cta: "登録"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    const targetEntry = result?.find(r => r.locale === 'ja_easy');
    expect(targetEntry!.changes).toEqual([
      { key: 'cta', status: 'added', value: '登録', source_value: 'Sign up' }
    ]);
  });

  test('omits source_value when the key is absent from the source file', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  greeting: "Hello"\n',
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  greeting: "Hello"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n  stray: "はぐれ"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    const targetEntry = result?.find(r => r.locale === 'ja_easy');
    expect(targetEntry!.changes).toEqual([
      { key: 'stray', status: 'added', value: 'はぐれ' }
    ]);
  });

  test('source-pass changes carry their own value as source_value', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  confirm: "Confirm"\n',
        'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  confirm: "Please confirm"\n',
      'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry!.changes).toEqual([
      { key: 'confirm', status: 'updated', value: 'Please confirm', old_value: 'Confirm', source_value: 'Please confirm' }
    ]);
  });
});

describe('detectTargetChanges — source pass', () => {
  test('emits updated change for changed source value', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  confirm: "Confirm"\n',
        'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  confirm: "Please confirm"\n',
      'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);

    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry).toEqual({
      path: 'config/locales/en.yml',
      source_path: 'config/locales/en.yml',
      locale: 'en',
      format: 'yml',
      changes: [
        { key: 'confirm', status: 'updated', value: 'Please confirm', old_value: 'Confirm', source_value: 'Please confirm' }
      ]
    });
  });

  test('emits nothing when source value is cleared to empty string', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  confirm: "Confirm"\n',
        'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  confirm: ""\n',
      'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeUndefined();
  });

  test('does not emit added source keys (only updated)', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  greeting: "Hello"\n',
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  greeting: "Hello"\n  new_key: "Brand new"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeUndefined();
  });

  test('emits nothing when source is unchanged', () => {
    const enContent = 'en:\n  greeting: "Hello"\n';
    setupGitMock({
      oldContent: {
        'en.yml': enContent,
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
      }
    });
    setupReadMock({
      'en.yml': enContent,
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeUndefined();
  });

  test('does not emit PO source file changes', () => {
    const poSourceFiles = [
      { path: 'locale/en.po', format: 'po', locale: 'en' }
    ];
    setupGitMock({
      oldContent: {
        'en.po': 'msgid "Confirm"\nmsgstr "Confirm"\n',
        'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
      }
    });
    setupReadMock({
      'en.po': 'msgid "Please confirm"\nmsgstr "Please confirm"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
    });

    const result = detectTargetChanges(poSourceFiles, targetFilesByLocale, config, false);
    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeUndefined();
  });

  test('does not emit ignored source keys', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  confirm: "Confirm"\n  ignored_key: "Old ignored"\n',
        'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  confirm: "Please confirm"\n  ignored_key: "New ignored"\n',
      'ja_easy.yml': 'ja_easy:\n  confirm: "確認"\n'
    });

    const ignoreMatcher = (key: string) => key === 'ignored_key';
    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false, ignoreMatcher);

    const sourceEntry = result?.find(r => r.locale === 'en');
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry!.changes).toEqual([
      { key: 'confirm', status: 'updated', value: 'Please confirm', old_value: 'Confirm', source_value: 'Please confirm' }
    ]);
    expect(sourceEntry!.changes.find(c => c.key === 'ignored_key')).toBeUndefined();
  });

  test('target added changes are still emitted (regression)', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  greeting: "Hello"\n',
        'ja_easy.yml': null
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  greeting: "Hello"\n',
      'ja_easy.yml': 'ja_easy:\n  greeting: "こんにちは"\n'
    });

    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
    const targetEntry = result?.find(r => r.locale === 'ja_easy');
    expect(targetEntry).toBeDefined();
    expect(targetEntry!.changes).toEqual([
      { key: 'greeting', status: 'added', value: 'こんにちは', source_value: 'Hello' }
    ]);
  });

  test('ignoreMatcher does NOT filter target changes (source-pass only)', () => {
    setupGitMock({
      oldContent: {
        'en.yml': 'en:\n  ignored_key: "Hello"\n',
        'ja_easy.yml': 'ja_easy:\n  ignored_key: "旧"\n'
      }
    });
    setupReadMock({
      'en.yml': 'en:\n  ignored_key: "Hello"\n',
      'ja_easy.yml': 'ja_easy:\n  ignored_key: "新"\n'
    });

    const ignoreMatcher = (key: string) => key === 'ignored_key';
    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false, ignoreMatcher);

    // Source unchanged so no en entry; the matcher must NOT suppress the target update.
    expect(result?.find(r => r.locale === 'en')).toBeUndefined();
    const targetEntry = result?.find(r => r.locale === 'ja_easy');
    expect(targetEntry!.changes).toEqual([
      { key: 'ignored_key', status: 'updated', value: '新', old_value: '旧', source_value: 'Hello' }
    ]);
  });

  test('returns null when combined target + source changes exceed the cap', () => {
    const manyKeys = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `  k${i}: "${prefix}${i}"`).join('\n');

    setupGitMock({
      oldContent: {
        'en.yml': `en:\n${manyKeys('old', 600)}\n`,
        'ja_easy.yml': `ja_easy:\n${manyKeys('jold', 600)}\n`
      }
    });
    setupReadMock({
      'en.yml': `en:\n${manyKeys('new', 600)}\n`,
      'ja_easy.yml': `ja_easy:\n${manyKeys('jnew', 600)}\n`
    });

    // 600 target + 600 source updates = 1200 > MAX_TOTAL_CHANGES (1000) → skip ingestion.
    const result = detectTargetChanges(sourceFiles, targetFilesByLocale, config, false);
    expect(result).toBeNull();
  });
});
