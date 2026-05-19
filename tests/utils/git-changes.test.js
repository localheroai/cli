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
  throwOnMergeBase = false,
  deletedPaths = '',
  showByPath = null
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

    if (cmd.startsWith('git diff --diff-filter=D')) {
      return deletedPaths;
    }

    if (cmd.includes('git show')) {
      if (throwOnShow) throw new Error('File does not exist in base branch');
      if (showByPath) {
        const match = cmd.match(/git show [^:]+:"([^"]+)"/);
        if (match && Object.prototype.hasOwnProperty.call(showByPath, match[1])) {
          const value = showByPath[match[1]];
          if (value === null) throw new Error('File does not exist in base branch');
          return value;
        }
      }
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
  // translations on long-lived branches.
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

    // Regression: previously, getChangedKeys collected bare key names into a
    // global Set<string>. filterMissing then checked that set without file
    // scope, so a key like `subject` introduced in file A would falsely match
    // a pre-existing missing `subject` translation in unrelated file B.
    // This is common in repos where each file uses its own top-level keys
    // (e.g. each email template has its own `subject` / `headline` / `body`),
    // causing a single new file to drag many unrelated files into the
    // translation pass.
    it('does NOT match missing keys in a file whose source did not change, even when another file has the same bare key', () => {
      const multiSourceFiles = [
        { path: 'emails/welcome.yml', format: 'yml', locale: 'en' },
        { path: 'emails/reminder.yml', format: 'yml', locale: 'en' }
      ];

      const welcomeOld = `en:
  subject: Welcome
  body: Hi
`;
      const welcomeNew = welcomeOld;

      const reminderNew = `en:
  subject: Reminder
  body: Hey
`;

      setupGitMock({
        showByPath: {
          'emails/welcome.yml': welcomeOld,
          'emails/reminder.yml': null
        }
      });

      mockReadFileSync.mockImplementation((p) => {
        if (p.endsWith('emails/welcome.yml')) return welcomeNew;
        if (p.endsWith('emails/reminder.yml')) return reminderNew;
        throw new Error(`Unexpected readFileSync path: ${p}`);
      });

      const missing = {
        'fr:emails/welcome.yml': {
          locale: 'fr',
          path: 'emails/welcome.yml',
          targetPath: 'emails/welcome.yml',
          keys: {
            subject: { value: 'Welcome', sourceKey: 'subject' },
            body: { value: 'Hi', sourceKey: 'body' }
          },
          keyCount: 2
        },
        'fr:emails/reminder.yml': {
          locale: 'fr',
          path: 'emails/reminder.yml',
          targetPath: 'emails/reminder.yml',
          keys: {
            subject: { value: 'Reminder', sourceKey: 'subject' },
            body: { value: 'Hey', sourceKey: 'body' }
          },
          keyCount: 2
        }
      };

      const result = filterByGitChanges(multiSourceFiles, missing, mockConfig, false);

      expect(result['fr:emails/welcome.yml']).toBeUndefined();
      expect(result['fr:emails/reminder.yml']).toBeDefined();
      expect(result['fr:emails/reminder.yml'].keyCount).toBe(2);
    });

    it('scopes per-file: each file passes only its own changed keys', () => {
      const multiSourceFiles = [
        { path: 'locales/a.json', format: 'json', locale: 'en' },
        { path: 'locales/b.json', format: 'json', locale: 'en' }
      ];

      const aOld = JSON.stringify({ shared: 'a-old' });
      const aNew = JSON.stringify({ shared: 'a-new', foo: 'A foo' });

      const bOld = JSON.stringify({ shared: 'b' });
      const bNew = JSON.stringify({ shared: 'b', bar: 'B bar' });

      setupGitMock({
        showByPath: {
          'locales/a.json': aOld,
          'locales/b.json': bOld
        }
      });

      mockReadFileSync.mockImplementation((p) => {
        if (p.endsWith('locales/a.json')) return aNew;
        if (p.endsWith('locales/b.json')) return bNew;
        throw new Error(`Unexpected path: ${p}`);
      });

      // Both files have BOTH `foo` and `bar` "missing" in fr — the filter must
      // give each file only the key actually added in THAT file.
      const missing = {
        'fr:locales/a.json': {
          locale: 'fr',
          path: 'locales/a.json',
          targetPath: 'locales/a.fr.json',
          keys: {
            foo: { value: 'A foo', sourceKey: 'foo' },
            bar: { value: 'B bar', sourceKey: 'bar' }
          },
          keyCount: 2
        },
        'fr:locales/b.json': {
          locale: 'fr',
          path: 'locales/b.json',
          targetPath: 'locales/b.fr.json',
          keys: {
            foo: { value: 'A foo', sourceKey: 'foo' },
            bar: { value: 'B bar', sourceKey: 'bar' }
          },
          keyCount: 2
        }
      };

      const result = filterByGitChanges(multiSourceFiles, missing, mockConfig, false);

      // a.json's filter set contains `shared` (value changed) and `foo` (new),
      // but `shared` isn't in a.json's missing entries, so it's a no-op.
      // `bar` is in a.json's missing entries but didn't change in a.json,
      // so it must NOT pass.
      expect(Object.keys(result['fr:locales/a.json'].keys).sort()).toEqual(['foo']);
      expect(Object.keys(result['fr:locales/b.json'].keys).sort()).toEqual(['bar']);
    });

    it('plural variants pass when their base key changed in the SAME file', () => {
      const sourceFiles = [
        { path: 'locales/en.json', format: 'json', locale: 'en' }
      ];

      const oldContent = JSON.stringify({});
      const newContent = JSON.stringify({ count: 'You have one' });

      setupGitMock({
        showByPath: { 'locales/en.json': oldContent }
      });
      mockReadFileSync.mockReturnValue(newContent);

      const missing = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: {
            count: { value: 'You have one', sourceKey: 'count' },
            count__plural_1: { value: 'You have many', sourceKey: 'count' }
          },
          keyCount: 2
        }
      };

      const result = filterByGitChanges(sourceFiles, missing, mockConfig, false);

      expect(result['fr:locales/en.json'].keys.count).toBeDefined();
      expect(result['fr:locales/en.json'].keys.count__plural_1).toBeDefined();
      expect(result['fr:locales/en.json'].keyCount).toBe(2);
    });

    it('plural variants do NOT pass when the base key did not change in THAT file', () => {
      const multiSourceFiles = [
        { path: 'locales/a.json', format: 'json', locale: 'en' },
        { path: 'locales/b.json', format: 'json', locale: 'en' }
      ];

      const aOld = JSON.stringify({});
      const aNew = JSON.stringify({ count: 'A one' });

      const bOld = JSON.stringify({ count: 'B one' });
      const bNew = bOld;

      setupGitMock({
        showByPath: {
          'locales/a.json': aOld,
          'locales/b.json': bOld
        }
      });
      mockReadFileSync.mockImplementation((p) => {
        if (p.endsWith('locales/a.json')) return aNew;
        if (p.endsWith('locales/b.json')) return bNew;
        throw new Error(`Unexpected path: ${p}`);
      });

      // b has a missing plural for `count__plural_1` BUT the base `count` in
      // b did not change. Only a's count plural should pass.
      const missing = {
        'fr:locales/a.json': {
          locale: 'fr',
          path: 'locales/a.json',
          targetPath: 'locales/a.fr.json',
          keys: {
            count: { value: 'A one', sourceKey: 'count' },
            count__plural_1: { value: 'A many', sourceKey: 'count' }
          },
          keyCount: 2
        },
        'fr:locales/b.json': {
          locale: 'fr',
          path: 'locales/b.json',
          targetPath: 'locales/b.fr.json',
          keys: {
            count__plural_1: { value: 'B many', sourceKey: 'count' }
          },
          keyCount: 1
        }
      };

      const result = filterByGitChanges(multiSourceFiles, missing, mockConfig, false);

      expect(result['fr:locales/a.json']).toBeDefined();
      expect(result['fr:locales/a.json'].keys.count).toBeDefined();
      expect(result['fr:locales/a.json'].keys.count__plural_1).toBeDefined();
      expect(result['fr:locales/b.json']).toBeUndefined();
    });

    it('multi-language source files with overlapping bare keys only translate files where the EN source actually changed', () => {
      // Multi-language YAML where each email-template file holds en+sv
      // blocks with its own top-level `subject` / `body` keys. Adding a
      // brand-new file with the same key names must NOT cause sibling
      // files to be flagged for translation.
      const multiSourceFiles = [
        { path: 'apps/email/welcome.yml', format: 'yml', locale: 'en' },
        { path: 'apps/email/booking_reminder.yml', format: 'yml', locale: 'en' }
      ];

      const welcomeOld = `en:
  subject: Welcome
  body: Hi there
sv:
  subject: Välkommen
  body: Hej
`;
      const welcomeNew = welcomeOld;

      const reminderNew = `en:
  subject: Booking reminder
  body: Your viewing is tomorrow
sv:
  subject: ''
  body: ''
`;

      setupGitMock({
        showByPath: {
          'apps/email/welcome.yml': welcomeOld,
          'apps/email/booking_reminder.yml': null
        }
      });
      mockReadFileSync.mockImplementation((p) => {
        if (p.endsWith('welcome.yml')) return welcomeNew;
        if (p.endsWith('booking_reminder.yml')) return reminderNew;
        throw new Error(`Unexpected path: ${p}`);
      });

      const missing = {
        'sv:apps/email/welcome.yml': {
          locale: 'sv',
          path: 'apps/email/welcome.yml',
          targetPath: 'apps/email/welcome.yml',
          keys: {
            subject: { value: 'Welcome', sourceKey: 'subject' },
            body: { value: 'Hi there', sourceKey: 'body' }
          },
          keyCount: 2
        },
        'sv:apps/email/booking_reminder.yml': {
          locale: 'sv',
          path: 'apps/email/booking_reminder.yml',
          targetPath: 'apps/email/booking_reminder.yml',
          keys: {
            subject: { value: 'Booking reminder', sourceKey: 'subject' },
            body: { value: 'Your viewing is tomorrow', sourceKey: 'body' }
          },
          keyCount: 2
        }
      };

      const result = filterByGitChanges(multiSourceFiles, missing, mockConfig, false);

      expect(result['sv:apps/email/welcome.yml']).toBeUndefined();
      expect(result['sv:apps/email/booking_reminder.yml']).toBeDefined();
      expect(result['sv:apps/email/booking_reminder.yml'].keyCount).toBe(2);
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
    expect(result.size).toBe(0);
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

  it('omits unchanged source files from the manifest', () => {
    const sourceFiles = [
      { path: 'locales/en.json', format: 'json', locale: 'en' },
      { path: 'locales/common.json', format: 'json', locale: 'en' }
    ];

    const content = JSON.stringify({ key: 'value' });
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getChangedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result.size).toBe(0);
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

    expect(result).toEqual({});
  });
});

describe('getRemovedKeysPerFile', () => {
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

  it('emits keys present in old but absent in new', () => {
    const sourceFiles = [{ path: 'locales/en.json', format: 'json', locale: 'en' }];
    const oldContent = JSON.stringify({ greeting: 'Hi', goodbye: 'Bye' });
    const newContent = JSON.stringify({ greeting: 'Hi' });

    setupGitMock({ oldContent });
    mockReadFileSync.mockReturnValue(newContent);

    const result = gitDiffModule.getRemovedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result).toBeInstanceOf(Map);
    expect(result.get('locales/en.json')).toEqual([{ name: 'goodbye' }]);
  });

  it('omits files with no removals from the map', () => {
    const sourceFiles = [{ path: 'locales/en.json', format: 'json', locale: 'en' }];
    const content = JSON.stringify({ greeting: 'Hi' });

    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getRemovedKeysPerFile(sourceFiles, mockConfig, false);

    expect(result.size).toBe(0);
  });

  it('parses PO context|msgid removals', () => {
    const sourceFiles = [{ path: 'msgs.po', format: 'po', locale: 'en' }];
    const oldContent = `
msgctxt "menu"
msgid "Open"
msgstr "Open"

msgid "Close"
msgstr "Close"
`;
    const newContent = `
msgid "Close"
msgstr "Close"
`;

    setupGitMock({ oldContent });
    mockReadFileSync.mockReturnValue(newContent);

    const result = gitDiffModule.getRemovedKeysPerFile(sourceFiles, mockConfig, false);

    const removed = result.get('msgs.po');
    expect(removed).toEqual([{ name: 'Open', context: 'menu' }]);
  });

  it('caps combined add+remove count at MAX_CHANGED_KEYS', () => {
    const sourceFiles = [{ path: 'locales/en.json', format: 'json', locale: 'en' }];

    // 6000 added + 5000 removed = 11000, exceeds 10000 cap.
    const oldEntries = {};
    for (let i = 0; i < 5000; i++) oldEntries[`removed_${i}`] = `r${i}`;
    const newEntries = {};
    for (let i = 0; i < 6000; i++) newEntries[`added_${i}`] = `a${i}`;

    setupGitMock({ oldContent: JSON.stringify(oldEntries) });
    mockReadFileSync.mockReturnValue(JSON.stringify(newEntries));

    const result = gitDiffModule.getRemovedKeysPerFile(sourceFiles, mockConfig, false);
    expect(result).toBeNull();
  });
});

describe('getRemovedKeysManifestForFinalize', () => {
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

  it('returns plain object', () => {
    const sourceFiles = [{ path: 'locales/en.json', format: 'json', locale: 'en' }];
    const oldContent = JSON.stringify({ greeting: 'Hi', goodbye: 'Bye' });
    const newContent = JSON.stringify({ greeting: 'Hi' });

    setupGitMock({ oldContent });
    mockReadFileSync.mockReturnValue(newContent);

    const result = gitDiffModule.getRemovedKeysManifestForFinalize(sourceFiles, mockConfig, false);

    expect(result).toEqual({ 'locales/en.json': [{ name: 'goodbye' }] });
  });

  it('returns empty object when diff succeeded with no removals', () => {
    const sourceFiles = [{ path: 'locales/en.json', format: 'json', locale: 'en' }];
    const content = JSON.stringify({ greeting: 'Hi' });
    setupGitMock({ oldContent: content });
    mockReadFileSync.mockReturnValue(content);

    const result = gitDiffModule.getRemovedKeysManifestForFinalize(sourceFiles, mockConfig, false);

    expect(result).toEqual({});
  });
});

describe('deleted source file enumeration', () => {
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = {
      schemaVersion: '1.0',
      projectId: 'test',
      sourceLocale: 'en',
      outputLocales: ['fr', 'sv'],
      translationFiles: { paths: ['locales/'] },
      lastSyncedAt: null
    };
  });

  it('emits removals for a fully-deleted source-locale file', () => {
    setupGitMock({
      deletedPaths: 'locales/en.json\n',
      showByPath: {
        'locales/en.json': JSON.stringify({ a: '1', b: '2' })
      }
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    // No source files passed in (file is deleted on disk).
    const result = gitDiffModule.getRemovedKeysPerFile([], mockConfig, false);
    const removed = result.get('locales/en.json');
    expect(removed.length).toBe(2);
    expect(removed.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('ignores deleted files outside configured paths', () => {
    setupGitMock({
      deletedPaths: 'README.md\nnotes/old.json\n',
      showByPath: {
        'notes/old.json': JSON.stringify({ a: '1' })
      }
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = gitDiffModule.getRemovedKeysPerFile([], mockConfig, false);
    expect(result.has('README.md')).toBe(false);
    expect(result.has('notes/old.json')).toBe(false);
  });

  it('ignores deleted target-locale-only files', () => {
    setupGitMock({
      deletedPaths: 'locales/fr.json\n',
      showByPath: {
        'locales/fr.json': JSON.stringify({ x: 'fr' })
      }
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = gitDiffModule.getRemovedKeysPerFile([], mockConfig, false);
    expect(result.has('locales/fr.json')).toBe(false);
  });

  it('ignores rename records (filter is D-only)', () => {
    // diff --diff-filter=D will not include renames; simulate empty output.
    setupGitMock({ deletedPaths: '' });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = gitDiffModule.getRemovedKeysPerFile([], mockConfig, false);
    expect(result.size).toBe(0);
  });

  it('detects deleted multi-language YAML when source locale is a top-level key', () => {
    const multiConfig = {
      ...mockConfig,
      translationFiles: { paths: ['locales/'], multiLanguageFiles: true }
    };

    const yamlContent = `en:
  a: A
  b: B
sv:
  a: A
  b: B`;

    setupGitMock({
      deletedPaths: 'locales/messages.yml\n',
      showByPath: {
        'locales/messages.yml': yamlContent
      }
    });
    mockReadFileSync.mockReturnValue('');

    const result = gitDiffModule.getRemovedKeysPerFile([], multiConfig, false);
    const removed = result.get('locales/messages.yml');
    expect(removed).toBeDefined();
    expect(removed.length).toBe(2);
    expect(removed.map((r) => r.name).sort()).toEqual(['a', 'b']);
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
