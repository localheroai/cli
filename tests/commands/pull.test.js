import { jest } from '@jest/globals';
import { pull } from '../../src/commands/pull.js';

global.fetch = jest.fn();
global.console = { log: jest.fn(), error: jest.fn() };

describe('pull command', () => {
  const mockSyncService = {
    checkForUpdates: jest.fn(),
    applyUpdates: jest.fn()
  };

  function createPullDeps(overrides = {}) {
    return {
      syncService: mockSyncService,
      ...overrides
    };
  }

  beforeEach(() => {
    global.fetch.mockReset();
    global.console.log.mockReset();
    global.console.error.mockReset();
    mockSyncService.checkForUpdates.mockReset();
    mockSyncService.applyUpdates.mockReset();
  });

  it('handles case when no updates are available', async () => {
    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: false,
      updates: []
    });

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: [] })
    });

    await pull({}, createPullDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith(false);
    expect(mockSyncService.applyUpdates).not.toHaveBeenCalled();
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('All translations are up to date'));
  });

  it('pulls updates when available', async () => {
    const mockUpdates = [
      { key: 'test.key', value: 'new value' }
    ];

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: mockUpdates })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 1,
      totalDeleted: 0
    });

    const result = await pull({}, createPullDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith(false);
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, false);
    expect(result).toEqual({ totalUpdates: 1, totalDeleted: 0 });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Updated 1 translations'));
  });

  it('handles deleted keys', async () => {
    const mockUpdates = {
      updates: {
        files: [],
        deleted_keys: [
          { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' }
        ]
      }
    };

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 0,
      totalDeleted: 1
    });

    const result = await pull({}, createPullDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith(false);
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, false);
    expect(result).toEqual({ totalUpdates: 0, totalDeleted: 1 });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Deleted 1 keys'));
  });

  it('supports verbose flag', async () => {
    const mockUpdates = [
      { key: 'test.key', value: 'new value' }
    ];

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: mockUpdates })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 1,
      totalDeleted: 0
    });

    await pull({ verbose: true }, createPullDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith(true);
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, true);
  });

  it('propagates errors during update check', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Network error' } })
    });

    mockSyncService.checkForUpdates.mockRejectedValue(new Error('Network error'));

    await expect(pull({}, createPullDeps()))
      .rejects
      .toThrow('Network error');
  });

  it('propagates invalid API key errors', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: {
          code: 'invalid_api_key',
          message: 'Invalid API key'
        }
      })
    });

    mockSyncService.checkForUpdates.mockRejectedValue(new Error('Your API key is invalid or has been revoked'));

    await expect(pull({}, createPullDeps()))
      .rejects
      .toThrow('Your API key is invalid or has been revoked');
  });

  it('propagates errors during updates', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updates: [{ key: 'test.key', value: 'new value' }]
      })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: [{ key: 'test.key', value: 'new value' }]
    });
    mockSyncService.applyUpdates.mockRejectedValue(new Error('Failed to apply updates'));

    await expect(pull({}, createPullDeps()))
      .rejects
      .toThrow('Failed to apply updates');
  });

  describe('--changed-only flag', () => {
    let mockGitUtils;
    let mockConfigUtils;
    let mockFileUtils;

    beforeEach(() => {
      mockGitUtils = {
        isGitAvailable: jest.fn(),
        getChangedKeysForProject: jest.fn()
      };

      mockConfigUtils = {
        getValidProjectConfig: jest.fn().mockResolvedValue({
          projectId: 'test-project',
          sourceLocale: 'en',
          outputLocales: ['fr', 'es'],
          translationFiles: {
            paths: ['locales/**/*.json'],
            baseBranch: 'main'
          }
        })
      };

      mockFileUtils = {
        findTranslationFiles: jest.fn().mockResolvedValue({
          sourceFiles: [
            { path: 'locales/en/common.json', locale: 'en', format: 'json' }
          ],
          targetFilesByLocale: {
            fr: [{ path: 'locales/fr/common.json', locale: 'fr', format: 'json' }],
            es: [{ path: 'locales/es/common.json', locale: 'es', format: 'json' }]
          },
          allFiles: [
            { path: 'locales/en/common.json', locale: 'en' },
            { path: 'locales/fr/common.json', locale: 'fr' },
            { path: 'locales/es/common.json', locale: 'es' }
          ]
        })
      };
    });

    it('should require git to be available', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(false);

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils
      });

      await expect(pull({ changedOnly: true }, deps))
        .rejects
        .toThrow('Git is required for the --changed-only flag');
    });

    it('should error when base branch does not exist', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(null); // null = base branch not found

      const mockUpdates = {
        updates: {
          files: [
            {
              path: 'locales/fr/common.json',
              languages: [{
                code: 'fr',
                translations: [
                  { key: 'app.title', value: 'Mon Application' },
                  { key: 'app.subtitle', value: 'Sous-titre' }
                ]
              }]
            }
          ],
          deleted_keys: []
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await expect(pull({ changedOnly: true }, deps))
        .rejects
        .toThrow('Could not determine changed keys');
    });

    it('should filter updates to only include changed keys', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(
        new Set(['app.title'])
      );

      const mockUpdates = {
        updates: {
          files: [
            {
              path: 'locales/fr/common.json',
              languages: [{
                code: 'fr',
                translations: [
                  { key: 'app.title', value: 'Mon Application' },
                  { key: 'app.subtitle', value: 'Sous-titre' },
                  { key: 'footer.text', value: 'Pied de page' }
                ]
              }]
            }
          ],
          deleted_keys: []
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      mockSyncService.applyUpdates.mockResolvedValue({
        totalUpdates: 1,
        totalDeleted: 0
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await pull({ changedOnly: true, verbose: true }, deps);

      expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            files: expect.arrayContaining([
              expect.objectContaining({
                path: 'locales/fr/common.json',
                languages: expect.arrayContaining([
                  expect.objectContaining({
                    code: 'fr',
                    translations: expect.arrayContaining([
                      expect.objectContaining({ key: 'app.title' })
                    ])
                  })
                ])
              })
            ])
          })
        }),
        true
      );

      const actualUpdates = mockSyncService.applyUpdates.mock.calls[0][0];
      expect(actualUpdates.updates.files[0].languages[0].translations).toHaveLength(1);
      expect(actualUpdates.updates.files[0].languages[0].translations[0].key).toBe('app.title');
    });

    it('should include plural forms when base key changes', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(
        new Set(['item', 'item__plural_1'])
      );

      const mockUpdates = {
        updates: {
          files: [
            {
              path: 'locales/es/common.json',
              languages: [{
                code: 'es',
                translations: [
                  { key: 'item', value: 'artículo' },
                  { key: 'item__plural_1', value: 'artículos' },
                  { key: 'other.key', value: 'otra clave' }
                ]
              }]
            }
          ],
          deleted_keys: []
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      mockSyncService.applyUpdates.mockResolvedValue({
        totalUpdates: 2,
        totalDeleted: 0
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await pull({ changedOnly: true }, deps);

      const actualUpdates = mockSyncService.applyUpdates.mock.calls[0][0];
      const translations = actualUpdates.updates.files[0].languages[0].translations;

      expect(translations).toHaveLength(2);
      expect(translations.map(t => t.key)).toEqual(['item', 'item__plural_1']);
    });

    it('should handle deleted keys filtering', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(
        new Set(['deprecated.feature'])
      );

      const mockUpdates = {
        updates: {
          files: [],
          deleted_keys: [
            { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' },
            { name: 'other.deleted', deleted_at: '2024-03-14T12:00:00Z' }
          ]
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      mockSyncService.applyUpdates.mockResolvedValue({
        totalUpdates: 0,
        totalDeleted: 1
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await pull({ changedOnly: true }, deps);

      const actualUpdates = mockSyncService.applyUpdates.mock.calls[0][0];
      expect(actualUpdates.updates.deleted_keys).toHaveLength(1);
      expect(actualUpdates.updates.deleted_keys[0].name).toBe('deprecated.feature');
    });

    it('should exit gracefully when no changed keys found', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(
        new Set() // Empty set = no changes
      );

      const mockUpdates = {
        updates: {
          files: [
            {
              path: 'locales/fr/common.json',
              languages: [{
                code: 'fr',
                translations: [{ key: 'some.key', value: 'Une valeur' }]
              }]
            }
          ],
          deleted_keys: []
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await pull({ changedOnly: true }, deps);

      expect(mockSyncService.applyUpdates).not.toHaveBeenCalled();
      expect(global.console.log).toHaveBeenCalledWith(
        expect.stringContaining('No changed keys to pull')
      );
    });

    it('should filter out files with no translations after filtering', async () => {
      mockGitUtils.isGitAvailable.mockReturnValue(true);
      mockGitUtils.getChangedKeysForProject.mockReturnValue(
        new Set(['app.title'])
      );

      const mockUpdates = {
        updates: {
          files: [
            {
              path: 'locales/fr/common.json',
              languages: [{
                code: 'fr',
                translations: [
                  { key: 'app.title', value: 'Mon Application' }
                ]
              }]
            },
            {
              path: 'locales/es/common.json',
              languages: [{
                code: 'es',
                translations: [
                  { key: 'other.key', value: 'Otra clave' } // Will be filtered out
                ]
              }]
            }
          ],
          deleted_keys: []
        }
      };

      mockSyncService.checkForUpdates.mockResolvedValue({
        hasUpdates: true,
        updates: mockUpdates
      });

      mockSyncService.applyUpdates.mockResolvedValue({
        totalUpdates: 1,
        totalDeleted: 0
      });

      const deps = createPullDeps({
        gitUtils: mockGitUtils,
        configUtils: mockConfigUtils,
        fileUtils: mockFileUtils
      });

      await pull({ changedOnly: true }, deps);

      const actualUpdates = mockSyncService.applyUpdates.mock.calls[0][0];

      expect(actualUpdates.updates.files).toHaveLength(1);
      expect(actualUpdates.updates.files[0].path).toBe('locales/fr/common.json');
    });
  });
});
