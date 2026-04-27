import { jest } from '@jest/globals';

const mockExecSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync
}));

let filterByGitChanges;
let extractLocaleContent;
let gitDiffModule;

import * as actualFs from 'fs';

jest.unstable_mockModule('fs', () => ({
  ...actualFs,
  readFileSync: mockReadFileSync
}));

beforeAll(async () => {
  gitDiffModule = await import('../../src/utils/git-changes.js');
  filterByGitChanges = gitDiffModule.filterByGitChanges;
  extractLocaleContent = gitDiffModule.extractLocaleContent;
});

function setupGitMock({
  available = true,
  inRepo = true,
  branchExists = true,
  oldContent = '',
  throwOnShow = false,
  mergeBase = '',
  throwOnMergeBase = false
} = {}) {
  mockExecSync.mockImplementation((cmd) => {
    if (!available) {
      throw new Error('git: command not found');
    }

    if (cmd === 'git rev-parse --git-dir') {
      if (!inRepo) throw new Error('not a git repository');
      return '';
    }

    if (cmd.includes('git rev-parse --verify')) {
      if (!branchExists) throw new Error('branch not found');
      return '';
    }

    if (cmd.startsWith('git merge-base')) {
      if (throwOnMergeBase) throw new Error('not a valid object name');
      return mergeBase;
    }

    if (cmd.includes('git show')) {
      if (throwOnShow) throw new Error('File does not exist in base branch');
      return oldContent;
    }

    return '';
  });
}

describe('git-changes module (object-based diff)', () => {
  let mockConfig;
  let mockSourceFiles;
  let mockMissingByLocale;
  let originalProcessEnv;

  beforeEach(() => {
    // Save original env
    originalProcessEnv = { ...process.env };
    delete process.env.CI;
    delete process.env.GITHUB_BASE_REF;

    // Reset mocks
    jest.clearAllMocks();

    // Default mock config
    mockConfig = {
      schemaVersion: '1.0',
      projectId: 'test',
      sourceLocale: 'en',
      outputLocales: ['fr', 'de'],
      translationFiles: {
        paths: ['locales/']
      },
      lastSyncedAt: null
    };

    mockSourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' }
    ];
    mockMissingByLocale = {
      'fr:locales/en.json': {
        locale: 'fr',
        path: 'locales/en.json',
        targetPath: 'locales/fr.json',
        keys: {
          'user.name': { value: 'Name', sourceKey: 'user.name' },
          'user.email': { value: 'Email', sourceKey: 'user.email' },
          'other': { value: 'Other', sourceKey: 'other' }
        },
        keyCount: 3
      }
    };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalProcessEnv;
  });

  describe('fallback behavior', () => {
    it('returns null when git is not available', () => {
      setupGitMock({ available: false });

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toBeNull();
    });

    it('returns null when not in a git repository', () => {
      setupGitMock({ inRepo: false });

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toBeNull();
    });

    it('returns null when base branch does not exist', () => {
      setupGitMock({ branchExists: false });

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toBeNull();
    });

    it('returns empty object when no changes detected', () => {
      const fileContent = JSON.stringify({ user: { other: 'Other' } });

      setupGitMock({ oldContent: fileContent });
      mockReadFileSync.mockReturnValue(fileContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toEqual({});
    });
  });

  // Regression: comparing against the base branch tip instead of the merge-base
  // attributed develop's progress to the user's branch and triggered spurious
  // translations on long-lived branches (Qasa 2026-04-27).
  describe('merge-base comparison', () => {
    it('compares against merge-base SHA instead of base ref tip', () => {
      const oldContent = JSON.stringify({ user: { other: 'Other' } });
      const newContent = JSON.stringify({ user: { other: 'Other', name: 'Name' } });
      const mergeBaseSha = 'abc1234567890abcdef1234567890abcdef12345';

      setupGitMock({ oldContent, mergeBase: mergeBaseSha });
      mockReadFileSync.mockReturnValue(newContent);

      filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      const showCalls = mockExecSync.mock.calls
        .map(([cmd]) => cmd)
        .filter(cmd => typeof cmd === 'string' && cmd.startsWith('git show'));

      expect(showCalls.length).toBeGreaterThan(0);
      // Every git show must use the merge-base SHA, never the raw base ref.
      showCalls.forEach(cmd => {
        expect(cmd).toContain(mergeBaseSha);
        expect(cmd).not.toMatch(/git show (origin\/)?main:/);
      });
    });

    it('falls back to base ref tip when merge-base cannot be computed (shallow clone)', () => {
      const oldContent = JSON.stringify({ user: { other: 'Other' } });
      const newContent = JSON.stringify({ user: { other: 'Other', name: 'Name' } });

      // Simulate shallow clone: merge-base throws (or returns empty).
      setupGitMock({ oldContent, throwOnMergeBase: true });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      // Still produces a result rather than aborting — falls back to comparing
      // against the resolved base ref. Pre-fix behavior preserved.
      expect(result).toBeDefined();
      const showCalls = mockExecSync.mock.calls
        .map(([cmd]) => cmd)
        .filter(cmd => typeof cmd === 'string' && cmd.startsWith('git show'));
      showCalls.forEach(cmd => {
        expect(cmd).toMatch(/git show (origin\/)?main:/);
      });
    });

    it('falls back to base ref tip when merge-base returns empty (unrelated histories)', () => {
      const oldContent = JSON.stringify({ user: { other: 'Other' } });
      const newContent = JSON.stringify({ user: { other: 'Other', name: 'Name' } });

      setupGitMock({ oldContent, mergeBase: '' });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toBeDefined();
      const showCalls = mockExecSync.mock.calls
        .map(([cmd]) => cmd)
        .filter(cmd => typeof cmd === 'string' && cmd.startsWith('git show'));
      showCalls.forEach(cmd => {
        expect(cmd).toMatch(/git show (origin\/)?main:/);
      });
    });
  });

  describe('JSON nested structure detection', () => {
    it('detects changed nested keys in JSON', () => {
      const oldContent = JSON.stringify({
        user: {
          other: 'Other'
        }
      });

      const newContent = JSON.stringify({
        user: {
          name: 'Name',
          email: 'Email',
          other: 'Other'
        }
      });

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toBeDefined();
      expect(result['fr:locales/en.json']).toBeDefined();
      expect(result['fr:locales/en.json'].keys['user.name']).toBeDefined();
      expect(result['fr:locales/en.json'].keys['user.email']).toBeDefined();
      expect(result['fr:locales/en.json'].keys['other']).toBeUndefined();
      expect(result['fr:locales/en.json'].keyCount).toBe(2);
    });

    it('detects value changes in nested JSON', () => {
      const oldContent = JSON.stringify({
        user: {
          name: 'Old Name'
        }
      });

      const newContent = JSON.stringify({
        user: {
          name: 'New Name'
        }
      });

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      mockMissingByLocale['fr:locales/en.json'].keys = {
        'user.name': { value: 'New Name', sourceKey: 'user.name' }
      };

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.json'].keys['user.name']).toBeDefined();
    });

    it('handles deeply nested JSON structures', () => {
      const oldContent = JSON.stringify({
        app: {
          user: {
            profile: {
              name: 'Name'
            }
          }
        }
      });

      const newContent = JSON.stringify({
        app: {
          user: {
            profile: {
              name: 'Name',
              email: 'Email'
            }
          }
        }
      });

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      mockMissingByLocale['fr:locales/en.json'].keys = {
        'app.user.profile.email': { value: 'Email', sourceKey: 'app.user.profile.email' }
      };

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.json'].keys['app.user.profile.email']).toBeDefined();
    });
  });

  describe('YAML nested structure detection', () => {
    it('detects changed nested keys in YAML', () => {
      const yamlSourceFiles = [
        { path: 'locales/en.yml', format: 'yml', locale: 'en' }
      ];

      const oldContent = `en:
  user:
    other: Other
`;

      const newContent = `en:
  user:
    name: Name
    email: Email
    other: Other
`;

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      mockMissingByLocale['fr:locales/en.yml'] = {
        locale: 'fr',
        path: 'locales/en.yml',
        targetPath: 'locales/fr.yml',
        keys: {
          'user.name': { value: 'Name', sourceKey: 'user.name' },
          'user.email': { value: 'Email', sourceKey: 'user.email' },
          'user.other': { value: 'Other', sourceKey: 'user.other' }
        },
        keyCount: 3
      };

      const result = filterByGitChanges(yamlSourceFiles, mockMissingByLocale, mockConfig, false);

      // Changed keys (name, email) should be included, unchanged key (other) should not
      expect(result['fr:locales/en.yml'].keys['user.name']).toBeDefined();
      expect(result['fr:locales/en.yml'].keys['user.email']).toBeDefined();
      expect(result['fr:locales/en.yml'].keys['user.other']).toBeUndefined();
    });
  });

  describe('PO file detection', () => {
    it('detects changed keys including plurals in PO files', () => {
      const poSourceFiles = [
        { path: 'locales/en.po', format: 'po', locale: 'en' }
      ];

      const oldContent = `msgid ""
msgstr ""

msgid "other"
msgstr "Other"
`;

      const newContent = `msgid ""
msgstr ""

msgid "user"
msgstr "User"

msgid "email"
msgstr "Email"

msgid "other"
msgstr "Other"
`;

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      mockMissingByLocale['fr:locales/en.po'] = {
        locale: 'fr',
        path: 'locales/en.po',
        targetPath: 'locales/fr.po',
        keys: {
          'user': { value: 'User', sourceKey: 'user' },
          'email': { value: 'Email', sourceKey: 'email' },
          'other': { value: 'Other', sourceKey: 'other' }
        },
        keyCount: 3
      };

      const result = filterByGitChanges(poSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.po'].keys['user']).toBeDefined();
      expect(result['fr:locales/en.po'].keys['email']).toBeDefined();
      expect(result['fr:locales/en.po'].keys['other']).toBeUndefined();
    });

    it('handles plural forms with __plural_ suffix in PO files', () => {
      const poSourceFiles = [
        { path: 'locales/en.po', format: 'po', locale: 'en' }
      ];

      const oldContent = `msgid ""
msgstr ""

msgid "book"
msgid_plural "books"
msgstr[0] "book"
msgstr[1] "books"
`;

      const newContent = `msgid ""
msgstr ""

msgid "book"
msgid_plural "books"
msgstr[0] "book"
msgstr[1] "books"

msgid "page"
msgid_plural "pages"
msgstr[0] "page"
msgstr[1] "pages"
`;

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      mockMissingByLocale['fr:locales/en.po'] = {
        locale: 'fr',
        path: 'locales/en.po',
        targetPath: 'locales/fr.po',
        keys: {
          'book': { value: 'book', sourceKey: 'book' },
          'book__plural_1': { value: 'books', sourceKey: 'book__plural_1' },
          'page': { value: 'page', sourceKey: 'page' },
          'page__plural_1': { value: 'pages', sourceKey: 'page__plural_1' }
        },
        keyCount: 4
      };

      const result = filterByGitChanges(poSourceFiles, mockMissingByLocale, mockConfig, false);

      // Only 'page' and 'page__plural_1' are new
      expect(result['fr:locales/en.po'].keys['page']).toBeDefined();
      expect(result['fr:locales/en.po'].keys['page__plural_1']).toBeDefined();
      // 'book' and 'book__plural_1' existed before, so not included
      expect(result['fr:locales/en.po'].keys['book']).toBeUndefined();
      expect(result['fr:locales/en.po'].keys['book__plural_1']).toBeUndefined();
    });

    it('includes all target plural forms when source has fewer forms', () => {
      // This tests the bug fix where Swedish (2 forms) changed, but Polish (4 forms) needs all forms
      const poSourceFiles = [
        { path: 'locales/sv.po', format: 'po', locale: 'sv' }
      ];

      const oldContent = `msgid ""
msgstr ""
`;

      const newContent = `msgid ""
msgstr ""

msgctxt "time-period"
msgid "Updated %(counter)s day ago"
msgid_plural "Updated %(counter)s days ago"
msgstr[0] "Uppdaterad för %(counter)s dag sedan"
msgstr[1] "Uppdaterad för %(counter)s dagar sedan"
`;

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      // Swedish source has 2 plural forms, but Polish target needs 4
      mockMissingByLocale['pl:locales/sv.po'] = {
        locale: 'pl',
        path: 'locales/sv.po',
        targetPath: 'locales/pl.po',
        keys: {
          'time-period|Updated %(counter)s day ago': {
            value: 'Uppdaterad för %(counter)s dag sedan',
            sourceKey: 'time-period|Updated %(counter)s day ago',
            context: 'time-period'
          },
          'time-period|Updated %(counter)s day ago__plural_1': {
            value: 'Uppdaterad för %(counter)s dagar sedan',
            sourceKey: 'time-period|Updated %(counter)s day ago__plural_1',
            context: 'time-period'
          },
          'time-period|Updated %(counter)s day ago__plural_2': {
            value: '',
            sourceKey: 'time-period|Updated %(counter)s day ago__plural_2',
            context: 'time-period'
          },
          'time-period|Updated %(counter)s day ago__plural_3': {
            value: '',
            sourceKey: 'time-period|Updated %(counter)s day ago__plural_3',
            context: 'time-period'
          }
        },
        keyCount: 4
      };

      const result = filterByGitChanges(poSourceFiles, mockMissingByLocale, mockConfig, false);

      // All 4 Polish plural forms should be included, even though Swedish only has 2
      expect(result['pl:locales/sv.po'].keys['time-period|Updated %(counter)s day ago']).toBeDefined();
      expect(result['pl:locales/sv.po'].keys['time-period|Updated %(counter)s day ago__plural_1']).toBeDefined();
      expect(result['pl:locales/sv.po'].keys['time-period|Updated %(counter)s day ago__plural_2']).toBeDefined();
      expect(result['pl:locales/sv.po'].keys['time-period|Updated %(counter)s day ago__plural_3']).toBeDefined();
      expect(result['pl:locales/sv.po'].keyCount).toBe(4);
    });

    it('correctly handles context-prefixed plural keys with pipe character', () => {
      // This verifies that the regex correctly strips __plural_N suffix from context|msgid__plural_N keys
      const poSourceFiles = [
        { path: 'locales/en.po', format: 'po', locale: 'en' }
      ];

      const oldContent = `msgid ""
msgstr ""
`;

      const newContent = `msgid ""
msgstr ""

msgctxt "action-label"
msgid "Delete item"
msgid_plural "Delete items"
msgstr[0] "Delete item"
msgstr[1] "Delete items"
`;

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      // Spanish has 3 plural forms, English has 2
      mockMissingByLocale['es:locales/en.po'] = {
        locale: 'es',
        path: 'locales/en.po',
        targetPath: 'locales/es.po',
        keys: {
          'action-label|Delete item': {
            value: 'Delete item',
            sourceKey: 'action-label|Delete item',
            context: 'action-label'
          },
          'action-label|Delete item__plural_1': {
            value: 'Delete items',
            sourceKey: 'action-label|Delete item__plural_1',
            context: 'action-label'
          },
          'action-label|Delete item__plural_2': {
            value: '',
            sourceKey: 'action-label|Delete item__plural_2',
            context: 'action-label'
          }
        },
        keyCount: 3
      };

      const result = filterByGitChanges(poSourceFiles, mockMissingByLocale, mockConfig, false);

      // All 3 Spanish plural forms should be included
      expect(result['es:locales/en.po']).toBeDefined();
      expect(result['es:locales/en.po'].keys['action-label|Delete item']).toBeDefined();
      expect(result['es:locales/en.po'].keys['action-label|Delete item__plural_1']).toBeDefined();
      expect(result['es:locales/en.po'].keys['action-label|Delete item__plural_2']).toBeDefined();
      expect(result['es:locales/en.po'].keyCount).toBe(3);

      // Verify the context prefix (pipe character) doesn't interfere with plural suffix matching
      const keys = Object.keys(result['es:locales/en.po'].keys);
      expect(keys.every(k => k.startsWith('action-label|'))).toBe(true);
    });
  });

  describe('new file handling', () => {
    it('treats all keys as changed when file is new', () => {
      const newContent = JSON.stringify({
        user: {
          name: 'Name',
          email: 'Email'
        }
      });

      setupGitMock({ throwOnShow: true });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.json'].keys['user.name']).toBeDefined();
      expect(result['fr:locales/en.json'].keys['user.email']).toBeDefined();
    });
  });

  describe('base branch resolution', () => {
    it('uses config baseBranch when provided', () => {
      mockConfig.translationFiles.baseBranch = 'develop';
      const fileContent = JSON.stringify({ user: { name: 'Name' } });

      setupGitMock({ oldContent: fileContent });
      mockReadFileSync.mockReturnValue(fileContent);

      filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git show develop'),
        expect.any(Object)
      );
    });

    it('uses GITHUB_BASE_REF when in GitHub Actions', () => {
      process.env.GITHUB_BASE_REF = 'main';
      const fileContent = JSON.stringify({ user: { name: 'Name' } });

      setupGitMock({ oldContent: fileContent });
      mockReadFileSync.mockReturnValue(fileContent);

      filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git show main'),
        expect.any(Object)
      );
    });

    it('defaults to main when no config or env var', () => {
      const fileContent = JSON.stringify({ user: { name: 'Name' } });

      setupGitMock({ oldContent: fileContent });
      mockReadFileSync.mockReturnValue(fileContent);

      filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git show main'),
        expect.any(Object)
      );
    });
  });

  describe('filter logic', () => {
    it('filters missing translations correctly', () => {
      const oldContent = JSON.stringify({
        user: { other: 'Other' }
      });

      const newContent = JSON.stringify({
        user: {
          name: 'Name',
          email: 'Email',
          other: 'Other'
        }
      });

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.json'].keyCount).toBe(2);
      expect(Object.keys(result['fr:locales/en.json'].keys)).toHaveLength(2);
    });

    it('removes entries with no matching keys', () => {
      const oldContent = JSON.stringify({
        user: { name: 'Name', email: 'Email', other: 'Other' }
      });

      const newContent = JSON.stringify({
        user: { name: 'Name', email: 'Email', other: 'Other' }
      });

      setupGitMock({ oldContent });
      mockReadFileSync.mockReturnValue(newContent);

      const result = filterByGitChanges(mockSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result).toEqual({});
    });
  });

  describe('file filtering', () => {
    it('returns null when git not available', () => {
      setupGitMock({ available: false });
      const result = gitDiffModule.filterFilesByGitChanges(mockSourceFiles, mockConfig, false);
      expect(result).toBeNull();
    });

    it('returns null when base branch does not exist', () => {
      setupGitMock({ branchExists: false });
      const result = gitDiffModule.filterFilesByGitChanges(mockSourceFiles, mockConfig, false);
      expect(result).toBeNull();
    });

    it('returns empty array when no files changed', () => {
      const fileContent = JSON.stringify({ user: { name: 'Name' } });
      setupGitMock({ oldContent: fileContent });
      mockReadFileSync.mockReturnValue(fileContent);
      const result = gitDiffModule.filterFilesByGitChanges(mockSourceFiles, mockConfig, false);
      expect(result).toEqual([]);
    });

    it('returns only changed files', () => {
      const files = [
        { path: 'locales/en.json', format: 'json', language: 'en' },
        { path: 'locales/sv.json', format: 'json', language: 'sv' }
      ];

      mockExecSync.mockImplementation((cmd) => {
        if (cmd.includes('git rev-parse')) return '';
        if (cmd.includes('en.json')) return 'old content';
        if (cmd.includes('sv.json')) return 'same content';
        return '';
      });

      mockReadFileSync.mockImplementation((filePath) => {
        if (filePath.includes('en.json')) return 'new content';
        if (filePath.includes('sv.json')) return 'same content';
        return '';
      });

      const result = gitDiffModule.filterFilesByGitChanges(files, mockConfig, false);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('locales/en.json');
    });

    it('includes new files not in base branch', () => {
      setupGitMock({ throwOnShow: true });
      mockReadFileSync.mockReturnValue('new file content');
      const result = gitDiffModule.filterFilesByGitChanges(mockSourceFiles, mockConfig, false);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('locales/en.json');
    });
  });
});

describe('getChangedKeysPerFile', () => {
  let mockConfig;
  let originalProcessEnv;

  beforeEach(() => {
    originalProcessEnv = { ...process.env };
    delete process.env.CI;
    delete process.env.GITHUB_BASE_REF;
    jest.clearAllMocks();

    mockConfig = {
      schemaVersion: '1.0',
      projectId: 'test',
      sourceLocale: 'en',
      outputLocales: ['fr'],
      translationFiles: { paths: ['locales/'] },
      lastSyncedAt: null
    };
  });

  afterEach(() => {
    process.env = originalProcessEnv;
  });

  it('returns Map with per-file key arrays', () => {
    const sourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' }
    ];

    const oldContent = JSON.stringify({ greeting: 'Hi' });
    const newContent = JSON.stringify({ greeting: 'Hi', farewell: 'Bye' });

    setupGitMock({ oldContent });
    mockReadFileSync.mockReturnValue(newContent);

    const result = gitDiffModule.getChangedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);

    const keys = result.get('locales/en.json');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual({ name: 'farewell' });
  });

  it('returns empty Map for no changes', () => {
    const sourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' }
    ];

    const content = JSON.stringify({ greeting: 'Hi' });
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getChangedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
    expect(result.get('locales/en.json')).toEqual([]);
  });

  it('returns null on ref resolution failure', () => {
    setupGitMock({ branchExists: false });

    const result = gitDiffModule.getChangedKeysPerFile(
      [{ path: 'locales/en.json', format: 'json', locale: 'en' }],
      mockConfig,
      false
    );

    expect(result).toBeNull();
  });

  it('includes all source files in manifest with empty arrays for unchanged', () => {
    const sourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' },
      { path: 'locales/common.json', format: 'json', locale: 'en' }
    ];

    const content = JSON.stringify({ key: 'value' });
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getChangedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result.size).toBe(2);
    expect(result.get('locales/en.json')).toEqual([]);
    expect(result.get('locales/common.json')).toEqual([]);
  });
});

describe('getManifestForFinalize', () => {
  let mockConfig;
  let originalProcessEnv;

  beforeEach(() => {
    originalProcessEnv = { ...process.env };
    delete process.env.CI;
    delete process.env.GITHUB_BASE_REF;
    jest.clearAllMocks();

    mockConfig = {
      schemaVersion: '1.0',
      projectId: 'test',
      sourceLocale: 'en',
      outputLocales: ['fr'],
      translationFiles: { paths: ['locales/'] },
      lastSyncedAt: null
    };
  });

  afterEach(() => {
    process.env = originalProcessEnv;
  });

  it('returns plain object from Map', () => {
    const sourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' }
    ];

    const oldContent = JSON.stringify({ greeting: 'Hi' });
    const newContent = JSON.stringify({ greeting: 'Hi', farewell: 'Bye' });

    setupGitMock({ oldContent });
    mockReadFileSync.mockReturnValue(newContent);

    const result = gitDiffModule.getManifestForFinalize(sourceFiles, mockConfig, false);

    expect(result).toEqual({
      'locales/en.json': [{ name: 'farewell' }]
    });
  });

  it('returns null on failure', () => {
    setupGitMock({ branchExists: false });

    const result = gitDiffModule.getManifestForFinalize(
      [{ path: 'locales/en.json', format: 'json', locale: 'en' }],
      mockConfig,
      false
    );

    expect(result).toBeNull();
  });

  it('returns empty object when no changes', () => {
    const content = JSON.stringify({ greeting: 'Hi' });
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getManifestForFinalize(
      [{ path: 'locales/en.json', format: 'json', locale: 'en' }],
      mockConfig,
      false
    );

    expect(result).toEqual({ 'locales/en.json': [] });
  });
});

describe('extractLocaleContent', () => {
  it('extracts content under locale key when present', () => {
    const obj = {
      en: {
        dashboard: { welcome: 'Hello', overview: 'Your overview' }
      }
    };

    const result = extractLocaleContent(obj, 'en');

    expect(result).toEqual({
      dashboard: { welcome: 'Hello', overview: 'Your overview' }
    });
  });

  it('returns original object when locale key not present', () => {
    const obj = { dashboard: { welcome: 'Hello' } };

    const result = extractLocaleContent(obj, 'en');

    expect(result).toEqual({ dashboard: { welcome: 'Hello' } });
  });

  it('returns original object when locale key is not an object', () => {
    const obj = { en: 'just a string', dashboard: { welcome: 'Hello' } };

    const result = extractLocaleContent(obj, 'en');

    expect(result).toEqual(obj);
  });
});
