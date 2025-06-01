import { jest } from '@jest/globals';
import { translate } from '../../src/commands/translate.js';

describe('translate command', () => {
  let mockConsole;
  let configUtils;
  let authUtils;
  let fileUtils;
  let translationUtils;
  let syncService;
  let gitUtils;

  function createTranslateDeps(overrides = {}) {
    return {
      console: mockConsole,
      configUtils,
      authUtils,
      fileUtils,
      translationUtils,
      syncService,
      gitUtils,
      ...overrides
    };
  }

  beforeAll(() => {
    jest.spyOn(process, 'exit').mockImplementation(() => { });
  });

  beforeEach(() => {
    mockConsole = { log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() };

    configUtils = {
      getProjectConfig: jest.fn().mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['fr'],
        translationFiles: {
          paths: ['locales/']
        }
      }),
      updateLastSyncedAt: jest.fn().mockResolvedValue(true)
    };

    authUtils = {
      checkAuth: jest.fn().mockResolvedValue(true)
    };

    fileUtils = {
      findTranslationFiles: jest.fn()
    };

    translationUtils = {
      createTranslationJob: jest.fn(),
      checkJobStatus: jest.fn(),
      updateTranslationFile: jest.fn().mockResolvedValue({ updatedKeys: ['farewell'] }),
      findMissingTranslations: jest.fn().mockReturnValue({
        missingKeys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        skippedKeys: {}
      }),
      findMissingTranslationsByLocale: jest.fn().mockReturnValue({}),
      batchKeysWithMissing: jest.fn().mockReturnValue({
        batches: [],
        errors: []
      }),
      processLocaleTranslations: jest.fn().mockImplementation((sourceKeys, targetLocale, _targetFiles, _sourceFile) => {
        return {
          missingKeys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
          skippedKeys: {},
          targetPath: `locales/${targetLocale}.json`
        };
      })
    };

    syncService = {
      checkForUpdates: jest.fn().mockResolvedValue({ hasUpdates: false }),
      applyUpdates: jest.fn().mockResolvedValue({ totalUpdates: 0, totalDeleted: 0 })
    };

    gitUtils = {
      autoCommitChanges: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('successfully translates missing keys', async () => {
    const sourceFilePath = 'locales/en/common.json';
    const targetFilePath = 'locales/fr/common.json';

    // Configure missing translations for this test
    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'fr:locales/en/common.json': {
        locale: 'fr',
        path: sourceFilePath,
        targetPath: targetFilePath,
        keys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        keyCount: 1
      }
    });

    // Configure batch for this test
    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [{
        sourceFilePath,
        sourceFile: {
          path: sourceFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            keys: {
              farewell: { value: 'Goodbye' }
            }
          })).toString('base64')
        },
        localeEntries: ['fr:locales/en/common.json'],
        locales: ['fr']
      }],
      errors: []
    });

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [{
        path: sourceFilePath,
        format: 'json',
        content: Buffer.from(JSON.stringify({
          farewell: 'Goodbye'
        })).toString('base64')
      }],
      targetFilesByLocale: {
        fr: [{
          path: targetFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            fr: {}
          })).toString('base64'),
          locale: 'fr'
        }]
      },
      allFiles: [
        { path: sourceFilePath, locale: 'en' },
        { path: targetFilePath, locale: 'fr' }
      ]
    });

    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [{
        id: 'job-123',
        language: { code: 'fr' }
      }]
    });

    translationUtils.checkJobStatus.mockResolvedValue({
      status: 'completed',
      translations: {
        data: { farewell: 'Au revoir' }
      },
      language: { code: 'fr' },
      translations_url: 'https://localhero.ai/projects/test-project/translations'
    });

    await translate({ verbose: true }, createTranslateDeps());

    // Verify job request format
    expect(translationUtils.createTranslationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFiles: [expect.objectContaining({
          path: sourceFilePath,
          format: 'json'
        })],
        targetLocales: ['fr'],
        targetPaths: expect.objectContaining({
          fr: targetFilePath
        })
      })
    );

    // Verify file update
    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      targetFilePath,
      { farewell: 'Au revoir' },
      'fr',
      sourceFilePath
    );

    expect(gitUtils.autoCommitChanges).toHaveBeenCalledWith('locales/', expect.objectContaining({
      keysTranslated: expect.any(Number),
      languages: expect.any(Array)
    }));

    // Verify console output indicates success
    const consoleOutput = mockConsole.log.mock.calls
      .map(call => typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0]))
      .join('\n');

    expect(consoleOutput).toContain('Found 2 translation files');
    expect(consoleOutput).toContain('Found 1 source files for locale en');
    expect(consoleOutput).toContain('Translations complete');
    expect(consoleOutput).toContain('Updated 1 keys in 1 languages');

    // Verify no errors were logged
    expect(mockConsole.error).not.toHaveBeenCalled();
  });

  it('handles multiple source files', async () => {
    translationUtils.updateTranslationFile
      .mockImplementationOnce((targetPath, translations) => {
        return Promise.resolve({ updatedKeys: ['farewell'], created: false });
      })
      .mockImplementationOnce((targetPath, translations) => {
        return Promise.resolve({ updatedKeys: ['welcome'], created: false });
      });

    const sourceFiles = [
      {
        path: 'locales/en/common.json',
        format: 'json',
        content: Buffer.from(JSON.stringify({
          farewell: 'Goodbye'
        })).toString('base64')
      },
      {
        path: 'locales/en/home.json',
        format: 'json',
        content: Buffer.from(JSON.stringify({
          welcome: 'Welcome'
        })).toString('base64')
      }
    ];

    // Configure missing translations for this test
    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'fr:locales/en/common.json': {
        locale: 'fr',
        path: 'locales/en/common.json',
        targetPath: 'locales/fr/common.json',
        keys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        keyCount: 1
      },
      'fr:locales/en/home.json': {
        locale: 'fr',
        path: 'locales/en/home.json',
        targetPath: 'locales/fr/home.json',
        keys: { welcome: { value: 'Welcome', sourceKey: 'welcome' } },
        keyCount: 1
      }
    });

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles,
      targetFilesByLocale: {
        fr: [
          {
            path: 'locales/fr/common.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({})).toString('base64'),
            locale: 'fr'
          },
          {
            path: 'locales/fr/home.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({})).toString('base64'),
            locale: 'fr'
          }
        ]
      },
      allFiles: [
        { path: 'locales/en/common.json', locale: 'en' },
        { path: 'locales/fr/common.json', locale: 'fr' },
        { path: 'locales/en/home.json', locale: 'en' },
        { path: 'locales/fr/home.json', locale: 'fr' }
      ]
    });

    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [
        {
          sourceFilePath: 'locales/en/common.json',
          sourceFile: {
            path: 'locales/en/common.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              keys: {
                farewell: { value: 'Goodbye' }
              }
            })).toString('base64')
          },
          localeEntries: ['fr:locales/en/common.json'],
          locales: ['fr']
        },
        {
          sourceFilePath: 'locales/en/home.json',
          sourceFile: {
            path: 'locales/en/home.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              keys: {
                welcome: { value: 'Welcome' }
              }
            })).toString('base64')
          },
          localeEntries: ['fr:locales/en/home.json'],
          locales: ['fr']
        }
      ],
      errors: []
    });

    translationUtils.createTranslationJob
      .mockResolvedValueOnce({
        jobs: [{ id: 'job-123', language: { code: 'fr' } }]
      })
      .mockResolvedValueOnce({
        jobs: [{ id: 'job-124', language: { code: 'fr' } }]
      });

    translationUtils.checkJobStatus
      .mockResolvedValueOnce({
        status: 'completed',
        translations: {
          data: { farewell: 'Au revoir' }
        },
        language: { code: 'fr' }
      })
      .mockResolvedValueOnce({
        status: 'completed',
        translations: {
          data: { welcome: 'Bienvenue' }
        },
        language: { code: 'fr' }
      });

    await translate({ verbose: true }, createTranslateDeps());

    // Verify each source file created a separate job
    expect(translationUtils.createTranslationJob).toHaveBeenCalledTimes(2);

    // Verify each file was updated separately
    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      'locales/fr/common.json',
      { farewell: 'Au revoir' },
      'fr',
      'locales/en/common.json'
    );

    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      'locales/fr/home.json',
      { welcome: 'Bienvenue' },
      'fr',
      'locales/en/home.json'
    );

    const consoleOutput = mockConsole.log.mock.calls
      .map(call => typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0]))
      .join('\n');

    expect(consoleOutput).toContain('Found 4 translation files');
    expect(consoleOutput).toContain('Found 2 source files for locale en');
    expect(consoleOutput).toContain('Updated 2 keys in 1 languages');
  });

  it('handles authentication failure', async () => {
    authUtils.checkAuth.mockResolvedValue(false);
    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [],
      targetFilesByLocale: {},
      allFiles: []
    });

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('Your API key is invalid')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles missing configuration', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [],
      targetFilesByLocale: {},
      allFiles: []
    });

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('No configuration found')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles missing translation files', async () => {
    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [],
      targetFilesByLocale: {},
      allFiles: []
    });

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('No translation files found')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles missing source files', async () => {
    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [],
      targetFilesByLocale: { fr: [] },
      allFiles: [{ path: 'locales/fr.json', locale: 'fr' }]
    });

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('No source files found for locale en')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles errors during translation job creation', async () => {
    const sourceFilePath = 'locales/en.json';

    // Configure missing translations for this test
    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'fr:locales/en.json': {
        locale: 'fr',
        path: sourceFilePath,
        targetPath: 'locales/fr.json',
        keys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        keyCount: 1
      }
    });

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [{
        path: sourceFilePath,
        format: 'json',
        content: Buffer.from(JSON.stringify({
          en: { farewell: 'Goodbye' }
        })).toString('base64')
      }],
      targetFilesByLocale: { fr: [] },
      allFiles: [
        { path: sourceFilePath, locale: 'en' }
      ]
    });

    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [{
        sourceFilePath,
        sourceFile: {
          path: sourceFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            keys: {
              farewell: { value: 'Goodbye' }
            }
          })).toString('base64')
        },
        localeEntries: [`fr:${sourceFilePath}`],
        locales: ['fr']
      }],
      errors: []
    });

    translationUtils.createTranslationJob.mockRejectedValue(new Error('API Error'));

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing translation jobs: API Error')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles job status check errors', async () => {
    const sourceFilePath = 'locales/en.json';

    // Configure missing translations for this test
    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'fr:locales/en.json': {
        locale: 'fr',
        path: sourceFilePath,
        targetPath: 'locales/fr.json',
        keys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        keyCount: 1
      }
    });

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [{
        path: sourceFilePath,
        format: 'json',
        content: Buffer.from(JSON.stringify({
          en: { farewell: 'Goodbye' }
        })).toString('base64')
      }],
      targetFilesByLocale: { fr: [] },
      allFiles: [
        { path: sourceFilePath, locale: 'en' }
      ]
    });

    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [{
        sourceFilePath,
        sourceFile: {
          path: sourceFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            keys: {
              farewell: { value: 'Goodbye' }
            }
          })).toString('base64')
        },
        localeEntries: [`fr:${sourceFilePath}`],
        locales: ['fr']
      }],
      errors: []
    });

    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [{ id: 'job-123' }]
    });

    translationUtils.checkJobStatus.mockRejectedValue(new Error('Status check failed'));

    await translate({}, createTranslateDeps());

    expect(mockConsole.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing translation jobs: Status check failed')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('correctly handles locale name as a key, not a wrapper', async () => {
    const sourceFilePath = 'locales/en/common.json';

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [{
        path: sourceFilePath,
        format: 'json',
        locale: 'en',
        content: Buffer.from(JSON.stringify({
          'language': 'Language',
          'en': 'en',
          'someOtherKey': 'Some value'
        })).toString('base64')
      }],
      targetFilesByLocale: {
        fr: [{
          path: 'locales/fr/common.json',
          format: 'json',
          locale: 'fr',
          content: Buffer.from(JSON.stringify({
            'language': 'Langue',
            'someOtherKey': 'Une valeur'
          })).toString('base64')
        }]
      },
      allFiles: [
        { path: sourceFilePath, locale: 'en' },
        { path: 'locales/fr/common.json', locale: 'fr' }
      ]
    });

    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'fr:locales/en/common.json': {
        locale: 'fr',
        path: sourceFilePath,
        targetPath: 'locales/fr/common.json',
        keys: { 'en': { value: 'en', sourceKey: 'en' } },
        keyCount: 1
      }
    });

    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [{
        sourceFilePath,
        sourceFile: {
          path: sourceFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            keys: {
              'en': { value: 'en' }
            }
          })).toString('base64')
        },
        localeEntries: ['fr:locales/en/common.json'],
        locales: ['fr']
      }],
      errors: []
    });

    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [{ id: 'job-123', language: { code: 'fr' } }]
    });

    translationUtils.checkJobStatus.mockResolvedValue({
      status: 'completed',
      translations: {
        data: { 'en': 'fr' }
      },
      language: { code: 'fr' }
    });

    await translate({ verbose: true }, createTranslateDeps());

    const jobCall = translationUtils.createTranslationJob.mock.calls[0][0];
    expect(jobCall.sourceFiles[0].path).toBe(sourceFilePath);

    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      'locales/fr/common.json',
      { 'en': 'fr' },
      'fr',
      sourceFilePath
    );
  });

  it('filters targetPaths to only include locales in the current batch', async () => {
    const sourceFilePath = 'locales/en.json';

    // Update config to include all three locales
    configUtils.getProjectConfig.mockResolvedValue({
      projectId: 'test-project',
      sourceLocale: 'en',
      outputLocales: ['fr', 'sv', 'nb'],
      translationFiles: {
        paths: ['locales/']
      }
    });

    // Configure missing translations for this test - only Norwegian has missing translations
    translationUtils.findMissingTranslationsByLocale.mockReturnValue({
      'nb:locales/en.json': {
        locale: 'nb',
        path: sourceFilePath,
        targetPath: 'locales/nb.json',
        keys: { farewell: { value: 'Goodbye', sourceKey: 'farewell' } },
        keyCount: 1
      }
    });

    fileUtils.findTranslationFiles.mockResolvedValue({
      sourceFiles: [{
        path: sourceFilePath,
        format: 'json',
        content: Buffer.from(JSON.stringify({
          farewell: 'Goodbye',
          hello: 'Hello'
        })).toString('base64')
      }],
      targetFilesByLocale: {
        fr: [{
          path: 'locales/fr.json',
          locale: 'fr',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            farewell: 'Au revoir'
          })).toString('base64')
        }],
        sv: [{
          path: 'locales/sv.json',
          locale: 'sv',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            farewell: 'Adjö'
          })).toString('base64')
        }],
        nb: [{
          path: 'locales/nb.json',
          locale: 'nb',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            // Missing the 'farewell' key - this will be seen as missing
          })).toString('base64')
        }]
      },
      allFiles: [
        { path: sourceFilePath, locale: 'en' },
        { path: 'locales/fr.json', locale: 'fr' },
        { path: 'locales/sv.json', locale: 'sv' },
        { path: 'locales/nb.json', locale: 'nb' }
      ]
    });

    // Mock batchKeysWithMissing to return only Norwegian missing translations
    translationUtils.batchKeysWithMissing.mockReturnValue({
      batches: [{
        sourceFilePath,
        sourceFile: {
          path: sourceFilePath,
          format: 'json',
          content: Buffer.from(JSON.stringify({
            keys: {
              farewell: { value: 'Goodbye' }
            }
          })).toString('base64')
        },
        localeEntries: [`nb:${sourceFilePath}`],
        locales: ['nb']
      }],
      errors: []
    });

    // Mock job creation response - with all locales in the request, but only nb in the response
    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [{ id: 'job-123', language: { code: 'nb' } }]
    });

    // Mock job status response
    translationUtils.checkJobStatus.mockResolvedValue({
      status: 'completed',
      translations: {
        data: { farewell: 'Farvel' }
      },
      language: { code: 'nb' }
    });

    await translate({}, createTranslateDeps());

    // Should only create one job (based on the source file)
    expect(translationUtils.createTranslationJob).toHaveBeenCalledTimes(1);

    // In our new implementation, the job request includes all locales
    // but only creates jobs for locales with missing keys
    const jobCall = translationUtils.createTranslationJob.mock.calls[0][0];
    expect(jobCall.sourceFiles[0].path).toBe(sourceFilePath);
    expect(jobCall.targetPaths).toHaveProperty('nb', 'locales/nb.json');

    // Verify that it called updateTranslationFile only for Norwegian
    expect(translationUtils.updateTranslationFile).toHaveBeenCalledTimes(1);
    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      'locales/nb.json',
      { farewell: 'Farvel' },
      'nb',
      sourceFilePath
    );

    // French and Swedish shouldn't have been updated since they had no missing keys
    const allCalls = translationUtils.updateTranslationFile.mock.calls;
    const frCall = allCalls.find(call => call[0] === 'locales/fr.json');
    const svCall = allCalls.find(call => call[0] === 'locales/sv.json');
    expect(frCall).toBeUndefined();
    expect(svCall).toBeUndefined();
  });
});