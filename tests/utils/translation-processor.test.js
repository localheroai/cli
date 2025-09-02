import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { processTranslationBatches, MAX_JOB_STATUS_CHECK_ATTEMPTS } from '../../src/utils/translation-processor.js';

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
      updateTranslationFile: jest.fn().mockImplementation((targetPath, translations) => {
        const keys = Object.keys(translations);
        return Promise.resolve({ updatedKeys: keys, created: false });
      })
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
        'locales/en.json',
        undefined,
        { projectId: 'test-project' }
      );

      // Verify the returned statistics
      expect(result.totalLanguages).toBe(1);
      expect(result.allJobIds).toEqual(['job-123']);
      expect(result.resultsBaseUrl).toBe('https://localhero.ai/projects/test-project/translations');
      expect(result.jobGroupShortUrl).toBeNull();
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
        'locales/en.json',
        undefined,
        { projectId: 'test-project' }
      );
      expect(result.totalLanguages).toBe(1);
      expect(result.uniqueKeysTranslated.size).toBe(1);
    });

    it('captures job group short URL when present in response', async () => {
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
        jobs: [{ id: 'job-123', language: { code: 'fr' } }],
        job_group: {
          id: 'test-group-123',
          short_url: 'https://app.localhero.dev/r/test-group-123'
        }
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

      expect(result.totalLanguages).toBe(1);
      expect(result.allJobIds).toEqual(['job-123']);
      expect(result.resultsBaseUrl).toBe('https://localhero.ai/projects/test-project/translations');
      expect(result.jobGroupShortUrl).toBe('https://app.localhero.dev/r/test-group-123');
      expect(result.uniqueKeysTranslated.size).toBe(1);
    });

    it('sends job group ID when provided', async () => {
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

      const testJobGroupId = 'test-group-abc123';

      mockTranslationUtils.createTranslationJob.mockResolvedValue({
        jobs: [{ id: 'job-123', language: { code: 'fr' } }],
        job_group: {
          id: testJobGroupId,
          short_url: `https://app.localhero.dev/r/${testJobGroupId}`
        }
      });

      mockTranslationUtils.checkJobStatus.mockResolvedValue({
        status: 'completed',
        translations: {
          data: { welcome: 'Bienvenue' }
        },
        language: { code: 'fr' }
      });

      const result = await processTranslationBatches(
        batches,
        missingByLocale,
        config,
        true,
        { console: mockConsole, translationUtils: mockTranslationUtils },
        testJobGroupId
      );

      // Verify that createTranslationJob was called with the job group ID
      expect(mockTranslationUtils.createTranslationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobGroupId: testJobGroupId
        })
      );

      expect(result.jobGroupShortUrl).toBe(`https://app.localhero.dev/r/${testJobGroupId}`);
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
        'locales/en/common.json',
        undefined,
        { projectId: 'test-project' }
      );
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/es/common.json',
        { welcome: 'Bienvenido' },
        'es',
        'locales/en/common.json',
        undefined,
        { projectId: 'test-project' }
      );
      expect(mockTranslationUtils.updateTranslationFile).toHaveBeenCalledWith(
        'locales/fr/home.json',
        { title: 'Accueil' },
        'fr',
        'locales/en/home.json',
        undefined,
        { projectId: 'test-project' }
      );
      expect(result.totalLanguages).toBe(2); // fr and es
      expect(result.allJobIds).toEqual(['job-fr-1', 'job-es-1', 'job-fr-2']);
      expect(result.uniqueKeysTranslated.size).toBe(2); // welcome and title
    });

    it('handles a job that repeatedly stays pending and hits max tries', async () => {
      const testJobId = 'job-always-pending';

      const batches = [
        {
          sourceFilePath: 'locales/en/pending.json',
          sourceFile: {
            path: 'locales/en/pending.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({ pending_key: 'Will stay pending' })).toString('base64')
          },
          localeEntries: [`fr:locales/en/pending.json`],
          locales: ['fr']
        }
      ];

      const missingByLocale = {
        'fr:locales/en/pending.json': {
          locale: 'fr',
          path: 'locales/en/pending.json',
          targetPath: 'locales/fr/pending.json',
          keys: { pending_key: { value: 'Will stay pending' } },
          keyCount: 1
        }
      };

      const config = { projectId: 'test-project-max-tries' };

      mockTranslationUtils.createTranslationJob.mockResolvedValue({
        jobs: [{ id: testJobId, language: { code: 'fr' } }]
      });

      mockTranslationUtils.checkJobStatus.mockImplementation(async (jobId, _includeTranslations) => {
        if (jobId === testJobId) {
          return { status: 'pending', job_id: jobId };
        }
        return { status: 'completed', translations: { data: {} }, language: { code: 'other' }, job_id: jobId };
      });

      jest.useFakeTimers();
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn((callback) => {
        if (typeof callback === 'function') {
          callback();
        }
        return 1;
      });

      try {
        const result = await processTranslationBatches(
          batches,
          missingByLocale,
          config,
          true,
          { console: mockConsole, translationUtils: mockTranslationUtils }
        );

        expect(mockConsole.warn).toHaveBeenCalledWith(
          expect.stringContaining(`Job ${testJobId} exceeded maximum retries (${MAX_JOB_STATUS_CHECK_ATTEMPTS}) and will be skipped.`)
        );

        const checkJobStatusCallsForTestJob = mockTranslationUtils.checkJobStatus.mock.calls.filter(
          call => call[0] === testJobId
        );
        expect(checkJobStatusCallsForTestJob.length).toBe(MAX_JOB_STATUS_CHECK_ATTEMPTS + 1); // +1 for final progress check
        // First 25 calls should have includeTranslations=true
        checkJobStatusCallsForTestJob.slice(0, MAX_JOB_STATUS_CHECK_ATTEMPTS).forEach(call => {
          expect(call[1]).toBe(true);
        });
        // Last call should have includeTranslations=false (final progress check)
        expect(checkJobStatusCallsForTestJob[MAX_JOB_STATUS_CHECK_ATTEMPTS][1]).toBe(false);

        expect(mockTranslationUtils.updateTranslationFile).not.toHaveBeenCalledWith(
          'locales/fr/pending.json',
          expect.anything(),
          'fr',
          'locales/en/pending.json'
        );

        expect(result.totalLanguages).toBe(0);
        expect(result.allJobIds).toEqual([testJobId]);
        expect(result.uniqueKeysTranslated.size).toBe(0);
        expect(result.resultsBaseUrl).toBeNull();
        expect(result.jobGroupShortUrl).toBeNull();

      } finally {
        global.setTimeout = originalSetTimeout;
        jest.useRealTimers();
      }
    });
  });
});