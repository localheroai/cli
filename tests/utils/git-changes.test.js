import { jest } from '@jest/globals';

const mockExecSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync
}));

let filterByGitChanges;
let gitDiffModule;

import * as actualFs from 'fs';

jest.unstable_mockModule('fs', () => ({
  ...actualFs,
  readFileSync: mockReadFileSync
}));

beforeAll(async () => {
  gitDiffModule = await import('../../src/utils/git-changes.js');
  filterByGitChanges = gitDiffModule.filterByGitChanges;
});

function setupGitMock({
  available = true,
  inRepo = true,
  branchExists = true,
  oldContent = '',
  throwOnShow = false
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
          'en.user.name': { value: 'Name', sourceKey: 'en.user.name' },
          'en.user.email': { value: 'Email', sourceKey: 'en.user.email' },
          'en.user.other': { value: 'Other', sourceKey: 'en.user.other' }
        },
        keyCount: 3
      };

      const result = filterByGitChanges(yamlSourceFiles, mockMissingByLocale, mockConfig, false);

      expect(result['fr:locales/en.yml'].keys['en.user.name']).toBeDefined();
      expect(result['fr:locales/en.yml'].keys['en.user.email']).toBeDefined();
      expect(result['fr:locales/en.yml'].keys['en.user.other']).toBeUndefined();
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
});
