import { jest } from '@jest/globals';

describe('syncService', () => {
  let mockConfigService;
  let mockTranslationsApi;
  let mockTranslationUpdater;
  let mockConsole;
  let mockFilesUtils;
  let syncService;
  let originalConsole;

  beforeEach(async () => {
    jest.resetModules();

    mockConfigService = {
      getValidProjectConfig: jest.fn(),
      updateLastSyncedAt: jest.fn()
    };

    mockTranslationsApi = {
      getUpdates: jest.fn()
    };

    mockTranslationUpdater = {
      updateTranslationFile: jest.fn(),
      deleteKeysFromTranslationFile: jest.fn()
    };

    mockFilesUtils = {
      findTranslationFiles: jest.fn().mockResolvedValue({
        allFiles: [
          { path: 'locales/en.json', locale: 'en' },
          { path: 'locales/fr.json', locale: 'fr' }
        ],
        sourceFiles: [
          { path: 'locales/en.json', locale: 'en' }
        ],
        targetFilesByLocale: {
          fr: [{ path: 'locales/fr.json', locale: 'fr' }]
        }
      })
    };

    originalConsole = { ...console };
    mockConsole = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn()
    };
    global.console = mockConsole;

    await jest.unstable_mockModule('../../src/utils/config.js', () => ({
      configService: mockConfigService
    }));

    await jest.unstable_mockModule('../../src/api/translations.js', () => mockTranslationsApi);

    await jest.unstable_mockModule('../../src/utils/translation-updater.js', () => mockTranslationUpdater);

    await jest.unstable_mockModule('../../src/utils/files.js', () => ({
      findTranslationFiles: mockFilesUtils.findTranslationFiles
    }));

    const syncServiceModule = await import('../../src/utils/sync-service.js');
    syncService = syncServiceModule.syncService;
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  describe('checkForUpdates', () => {
    const testConfig = {
      projectId: 'test-project',
      lastSyncedAt: '2024-01-01T00:00:00Z'
    };

    it('checks for updates successfully with no changes', async () => {
      mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);
      mockTranslationsApi.getUpdates.mockResolvedValue({
        updates: { files: [] }
      });

      const result = await syncService.checkForUpdates({ verbose: true });

      expect(result).toEqual({ hasUpdates: false });
      expect(mockTranslationsApi.getUpdates).toHaveBeenCalledWith(
        'test-project',
        { since: '2024-01-01T00:00:00Z', page: 1 }
      );
    });

    it('handles multiple pages of updates', async () => {
      mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

      mockTranslationsApi.getUpdates
        .mockResolvedValueOnce({
          updates: {
            updated_keys: [{ path: 'file1.json' }]
          },
          pagination: {
            current_page: 1,
            total_pages: 2
          }
        })
        .mockResolvedValueOnce({
          updates: {
            updated_keys: [{ path: 'file2.json' }]
          },
          pagination: {
            current_page: 2,
            total_pages: 2
          }
        });

      const result = await syncService.checkForUpdates();

      expect(result.hasUpdates).toBe(true);
      expect(result.updates.updates.files).toHaveLength(2);
      expect(mockTranslationsApi.getUpdates).toHaveBeenCalledTimes(2);
    });

    it('handles missing project configuration', async () => {
      mockConfigService.getValidProjectConfig.mockRejectedValue(
        new Error('Project not initialized')
      );

      await expect(syncService.checkForUpdates())
        .rejects
        .toThrow('Project not initialized');
    });

    it('limits pagination to MAX_PAGES', async () => {
      mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

      const mockResponse = {
        updates: {
          updated_keys: [{ path: 'file.json' }]
        },
        pagination: {
          current_page: 1,
          total_pages: 20
        }
      };

      mockTranslationsApi.getUpdates.mockResolvedValue(mockResponse);

      await syncService.checkForUpdates({ verbose: true });

      expect(mockTranslationsApi.getUpdates).toHaveBeenCalledTimes(100);
    });

    it('includes deleted keys in the updates', async () => {
      mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

      mockTranslationsApi.getUpdates.mockResolvedValue({
        updates: {
          updated_keys: [{ path: 'file1.json' }],
          deleted_keys: [
            { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' }
          ]
        }
      });

      const result = await syncService.checkForUpdates();

      expect(result.hasUpdates).toBe(true);
      expect(result.updates.updates.files).toHaveLength(1);
      expect(result.updates.updates.deleted_keys).toHaveLength(1);
      expect(result.updates.updates.deleted_keys[0].name).toBe('deprecated.feature');
    });
  });

  describe('applyUpdates', () => {
    const testUpdates = {
      updates: {
        files: [
          {
            path: 'locales/en.json',
            languages: [
              {
                code: 'en',
                translations: [
                  {
                    key: 'greeting',
                    value: 'Hello'
                  },
                  {
                    key: 'farewell',
                    value: 'Goodbye'
                  }
                ]
              }
            ]
          }
        ]
      }
    };

    it('applies updates successfully', async () => {
      mockFilesUtils.findTranslationFiles.mockResolvedValueOnce({
        sourceFiles: [
          { path: 'locales/en.json', locale: 'en' }
        ],
        allFiles: [],
        targetFilesByLocale: {}
      });

      mockTranslationUpdater.updateTranslationFile.mockResolvedValue();
      mockConfigService.updateLastSyncedAt.mockResolvedValue();

      const result = await syncService.applyUpdates(testUpdates, { verbose: true });

      expect(result.totalUpdates).toBe(2);
      expect(mockTranslationUpdater.updateTranslationFile).toHaveBeenCalledWith(
        'locales/en.json',
        {
          greeting: 'Hello',
          farewell: 'Goodbye'
        },
        'en',
        'locales/en.json'
      );
      expect(mockConfigService.updateLastSyncedAt).toHaveBeenCalled();
    });

    it('handles file update errors', async () => {
      mockFilesUtils.findTranslationFiles.mockResolvedValueOnce({
        sourceFiles: [
          { path: 'locales/en.json', locale: 'en' }
        ],
        allFiles: [],
        targetFilesByLocale: {}
      });

      mockTranslationUpdater.updateTranslationFile.mockRejectedValue(
        new Error('Failed to write file')
      );
      mockConfigService.updateLastSyncedAt.mockResolvedValue();

      const result = await syncService.applyUpdates(testUpdates);

      expect(result.totalUpdates).toBe(0);
      expect(mockConsole.error).toHaveBeenCalled();
      expect(mockConfigService.updateLastSyncedAt).toHaveBeenCalled();
    });

    it('handles empty updates', async () => {
      mockFilesUtils.findTranslationFiles.mockResolvedValueOnce({
        sourceFiles: [
          { path: 'locales/en.json', locale: 'en' }
        ],
        allFiles: [],
        targetFilesByLocale: {}
      });

      const emptyUpdates = {
        updates: {
          files: []
        }
      };

      const result = await syncService.applyUpdates(emptyUpdates);

      expect(result.totalUpdates).toBe(0);
      expect(mockTranslationUpdater.updateTranslationFile).not.toHaveBeenCalled();
      expect(mockConfigService.updateLastSyncedAt).toHaveBeenCalled();
    });

    it('handles long translation values in verbose mode', async () => {
      mockFilesUtils.findTranslationFiles.mockResolvedValueOnce({
        sourceFiles: [
          { path: 'locales/en.json', locale: 'en' }
        ],
        allFiles: [],
        targetFilesByLocale: {}
      });

      const longUpdates = {
        updates: {
          files: [
            {
              path: 'locales/en.json',
              languages: [
                {
                  code: 'en',
                  translations: [
                    {
                      key: 'long_text',
                      value: 'a'.repeat(200)
                    }
                  ]
                }
              ]
            }
          ]
        }
      };

      mockTranslationUpdater.updateTranslationFile.mockResolvedValue();
      mockConfigService.updateLastSyncedAt.mockResolvedValue();

      await syncService.applyUpdates(longUpdates, { verbose: true });

      expect(mockTranslationUpdater.updateTranslationFile).toHaveBeenCalledWith(
        'locales/en.json',
        { long_text: 'a'.repeat(200) },
        'en',
        'locales/en.json'
      );

      const logCall = mockConsole.log.mock.calls.find(call =>
        call[0].includes('long_text')
      );
      expect(logCall[0]).toContain('…');
    });

    it('applies deleted keys', async () => {
      const updatesWithDeleted = {
        updates: {
          files: [],
          deleted_keys: [
            { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' }
          ]
        }
      };

      mockFilesUtils.findTranslationFiles
        .mockResolvedValueOnce({
          sourceFiles: [
            { path: 'locales/en.json', locale: 'en' }
          ],
          allFiles: [],
          targetFilesByLocale: {}
        })
        .mockResolvedValueOnce([
          { path: 'locales/en.json', locale: 'en' },
          { path: 'locales/fr.json', locale: 'fr' }
        ]);

      mockTranslationUpdater.deleteKeysFromTranslationFile.mockResolvedValue(['deprecated.feature']);
      mockConfigService.updateLastSyncedAt.mockResolvedValue();

      const result = await syncService.applyUpdates(updatesWithDeleted, { verbose: true });

      expect(mockFilesUtils.findTranslationFiles).toHaveBeenCalledTimes(2);
      expect(mockTranslationUpdater.deleteKeysFromTranslationFile).toHaveBeenCalledTimes(2);
      expect(mockTranslationUpdater.deleteKeysFromTranslationFile).toHaveBeenCalledWith(
        'locales/en.json',
        ['deprecated.feature'],
        'en'
      );
      expect(mockTranslationUpdater.deleteKeysFromTranslationFile).toHaveBeenCalledWith(
        'locales/fr.json',
        ['deprecated.feature'],
        'fr'
      );
      expect(result.totalDeleted).toBe(2);
    });

    it('handles errors when deleting keys', async () => {
      const updatesWithDeleted = {
        updates: {
          files: [],
          deleted_keys: [
            { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' }
          ]
        }
      };

      mockFilesUtils.findTranslationFiles
        .mockResolvedValueOnce({
          sourceFiles: [
            { path: 'locales/en.json', locale: 'en' }
          ],
          allFiles: [],
          targetFilesByLocale: {}
        })
        .mockResolvedValueOnce([
          { path: 'locales/en.json', locale: 'en' }
        ]);

      mockTranslationUpdater.deleteKeysFromTranslationFile.mockRejectedValue(
        new Error('Failed to delete key')
      );

      mockConfigService.updateLastSyncedAt.mockResolvedValue();

      const result = await syncService.applyUpdates(updatesWithDeleted);

      expect(mockConsole.error).toHaveBeenCalled();
      expect(result.totalDeleted).toBe(0);
    });
  });
});