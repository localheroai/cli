import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { processTranslationBatches } from '../../src/utils/translation-processor.js';

describe('translation-processor', () => {
  let mockConsole;
  let mockTranslationUtils;
  let originalConsole;

  beforeEach(() => {
    originalConsole = { ...console };
    mockConsole = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    };

    mockTranslationUtils = {
      createTranslationJob: jest.fn(),
      checkJobStatus: jest.fn(),
      updateTranslationFile: jest.fn().mockResolvedValue({ updatedKeys: ['welcome'], created: false })
    };
  });

  afterEach(() => {
    global.console = originalConsole;
    jest.clearAllMocks();
  });

  describe('processTranslationBatches', () => {
    it('processes translation batches successfully', async () => {
      const batches = [
        {
          sourceFilePath: 'locales/en.json',
          sourceFile: {
            path: 'locales/en.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({ welcome: 'Welcome' })).toString('base64')
          },
          localeEntries: ['fr:locales/en.json'],
          locales: ['fr']
        }
      ];

      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: { welcome: { value: 'Welcome', sourceKey: 'welcome' } },
          keyCount: 1
        }
      };

      const config = {
        projectId: 'test-project'
      };

      mockTranslationUtils.createTranslationJob.mockResolvedValue({
        jobs: [{ id: 'job-123', language: { code: 'fr' } }]
      });

      mockTranslationUtils.checkJobStatus.mockResolvedValue({
        status: 'completed',
        translations: {
          data: { welcome: 'Bienvenue' }
        },
        language: { code: 'fr' },
        results_url: 'https://localhero.ai/projects/test-project/translations?job_id=job-123'
      });

      const result = await processTranslationBatches(
        batches,
        missingByLocale,
        config,
        true,
        { console: mockConsole, translationUtils: mockTranslationUtils }
      );

      expect(mockTranslationUtils.createTranslationJob).toHaveBeenCalledWith({
        projectId: 'test-project',
        sourceFiles: [batches[0].sourceFile],
        targetLocales: ['fr'],
        targetPaths: { fr: 'locales/fr.json' }
      });

      expect(mockTranslationUtils.checkJobStatus).toHaveBeenCalledWith('job-123', true);

      // Verify updateTranslationFile was called with correct parameters
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/fr.json',
        { welcome: 'Bienvenue' },
        'fr',
        'locales/en.json'
      );

      // Verify the returned statistics
      expect(result.totalLanguages).toBe(1);
      expect(result.allJobIds).toEqual(['job-123']);
      expect(result.resultsBaseUrl).toBe('https://localhero.ai/projects/test-project/translations');
      expect(result.uniqueKeysTranslated.size).toBe(1);
      expect(result.uniqueKeysTranslated.has('welcome')).toBe(true);
    });

    it('handles job status transitions', async () => {
      const batches = [
        {
          sourceFilePath: 'locales/en.json',
          sourceFile: {
            path: 'locales/en.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({ greeting: 'Hello' })).toString('base64')
          },
          localeEntries: ['fr:locales/en.json'],
          locales: ['fr']
        }
      ];

      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: { greeting: { value: 'Hello', sourceKey: 'greeting' } },
          keyCount: 1
        }
      };

      const config = { projectId: 'test-project' };

      mockTranslationUtils.createTranslationJob.mockResolvedValue({
        jobs: [{ id: 'job-123', language: { code: 'fr' } }]
      });

      mockTranslationUtils.checkJobStatus
        .mockResolvedValueOnce({
          status: 'pending'
        })
        .mockResolvedValueOnce({
          status: 'processing'
        })
        .mockResolvedValueOnce({
          status: 'completed',
          translations: {
            data: { greeting: 'Bonjour' }
          },
          language: { code: 'fr' }
        });

      jest.useFakeTimers();
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn((callback) => {
        callback();
        return 1;
      });

      const result = await processTranslationBatches(
        batches,
        missingByLocale,
        config,
        true,
        { console: mockConsole, translationUtils: mockTranslationUtils }
      );

      global.setTimeout = originalSetTimeout;

      expect(mockTranslationUtils.checkJobStatus).toHaveBeenCalledTimes(3);
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/fr.json',
        { greeting: 'Bonjour' },
        'fr',
        'locales/en.json'
      );
      expect(result.totalLanguages).toBe(1);
      expect(result.uniqueKeysTranslated.size).toBe(1);
    });

    it('processes multiple batches and jobs', async () => {
      const batches = [
        {
          sourceFilePath: 'locales/en/common.json',
          sourceFile: {
            path: 'locales/en/common.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({ welcome: 'Welcome' })).toString('base64')
          },
          localeEntries: ['fr:locales/en/common.json', 'es:locales/en/common.json'],
          locales: ['fr', 'es']
        },
        {
          sourceFilePath: 'locales/en/home.json',
          sourceFile: {
            path: 'locales/en/home.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({ title: 'Home' })).toString('base64')
          },
          localeEntries: ['fr:locales/en/home.json'],
          locales: ['fr']
        }
      ];

      const missingByLocale = {
        'fr:locales/en/common.json': {
          locale: 'fr',
          path: 'locales/en/common.json',
          targetPath: 'locales/fr/common.json',
          keys: { welcome: { value: 'Welcome' } },
          keyCount: 1
        },
        'es:locales/en/common.json': {
          locale: 'es',
          path: 'locales/en/common.json',
          targetPath: 'locales/es/common.json',
          keys: { welcome: { value: 'Welcome' } },
          keyCount: 1
        },
        'fr:locales/en/home.json': {
          locale: 'fr',
          path: 'locales/en/home.json',
          targetPath: 'locales/fr/home.json',
          keys: { title: { value: 'Home' } },
          keyCount: 1
        }
      };

      const config = { projectId: 'test-project' };

      mockTranslationUtils.createTranslationJob
        .mockResolvedValueOnce({
          jobs: [
            { id: 'job-fr-1', language: { code: 'fr' } },
            { id: 'job-es-1', language: { code: 'es' } }
          ]
        })
        .mockResolvedValueOnce({
          jobs: [
            { id: 'job-fr-2', language: { code: 'fr' } }
          ]
        });

      mockTranslationUtils.checkJobStatus
        .mockImplementation((jobId) => {
          if (jobId === 'job-fr-1') {
            return Promise.resolve({
              status: 'completed',
              translations: { data: { welcome: 'Bienvenue' } },
              language: { code: 'fr' }
            });
          } else if (jobId === 'job-es-1') {
            return Promise.resolve({
              status: 'completed',
              translations: { data: { welcome: 'Bienvenido' } },
              language: { code: 'es' }
            });
          } else if (jobId === 'job-fr-2') {
            return Promise.resolve({
              status: 'completed',
              translations: { data: { title: 'Accueil' } },
              language: { code: 'fr' }
            });
          }
        });

      const result = await processTranslationBatches(
        batches,
        missingByLocale,
        config,
        false,
        { console: mockConsole, translationUtils: mockTranslationUtils }
      );

      expect(mockTranslationUtils.createTranslationJob).toHaveBeenCalledTimes(2);
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/fr/common.json',
        { welcome: 'Bienvenue' },
        'fr',
        'locales/en/common.json'
      );
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/es/common.json',
        { welcome: 'Bienvenido' },
        'es',
        'locales/en/common.json'
      );
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/fr/home.json',
        { title: 'Accueil' },
        'fr',
        'locales/en/home.json'
      );
      expect(result.totalLanguages).toBe(2); // fr and es
      expect(result.allJobIds).toEqual(['job-fr-1', 'job-es-1', 'job-fr-2']);
      expect(result.uniqueKeysTranslated.size).toBe(2); // welcome and title
    });
  });
});