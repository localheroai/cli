import { jest } from '@jest/globals';

describe('translations API', () => {
  let mockGetApiKey;
  let mockGetCurrentBranch;
  let getUpdates;
  let createTranslationJob;
  let checkJobStatus;
  let getTranslations;

  beforeEach(async () => {
    jest.resetModules();
    global.fetch = jest.fn();

    mockGetApiKey = jest.fn().mockResolvedValue('tk_123456789012345678901234567890123456789012345678');
    mockGetCurrentBranch = jest.fn().mockResolvedValue(null);
    await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
      getApiKey: mockGetApiKey
    }));
    await jest.unstable_mockModule('../../src/utils/git.js', () => ({
      getCurrentBranch: mockGetCurrentBranch
    }));

    const translationsModule = await import('../../src/api/translations.js');
    getUpdates = translationsModule.getUpdates;
    createTranslationJob = translationsModule.createTranslationJob;
    checkJobStatus = translationsModule.checkJobStatus;
    getTranslations = translationsModule.getTranslations;
  });

  describe('createTranslationJob', () => {
    it('creates translation job successfully', async () => {
      mockGetCurrentBranch.mockResolvedValueOnce('feature/test-branch');
      const mockResponse = {
        jobs: [
          {
            id: 'job_123',
            status: 'pending',
            target_language: 'fr',
            created_at: '2024-03-15T14:30:00Z'
          }
        ]
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const projectId = 'proj_123';
      const sourceFiles = [{
        path: 'locales/en.yml',
        content: 'content123',
        format: 'yaml'
      }];
      const targetLocales = ['fr'];

      const result = await createTranslationJob({ projectId, sourceFiles, targetLocales });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/projects/proj_123/translation_jobs',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
          },
          body: JSON.stringify({
            target_languages: targetLocales,
            files: sourceFiles,
            branch: 'feature/test-branch'
          })
        }
      );
      expect(result).toEqual({
        jobs: mockResponse.jobs,
        totalJobs: 1
      });
    });

    it('handles empty jobs response', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ jobs: [] })
      });

      await expect(createTranslationJob({
        projectId: 'proj_123',
        sourceFiles: [],
        targetLocales: ['fr']
      })).rejects.toThrow('No translation jobs were created');
    });
  });

  describe('checkJobStatus', () => {
    it('checks job status successfully without translations', async () => {
      const mockResponse = {
        id: 'job_123',
        status: 'completed',
        progress: { percentage: 100 },
        target_language: 'fr',
        completed_at: '2024-03-15T14:31:00Z'
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await checkJobStatus('job_123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/translation_jobs/job_123',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
          }
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('checks job status with translations included', async () => {
      const mockResponse = {
        id: 'job_123',
        status: 'completed',
        translations: {
          'welcome.title': 'Bienvenue'
        }
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await checkJobStatus('job_123', true);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/translation_jobs/job_123?include_translations=true',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
          }
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getTranslations', () => {
    it('fetches translations successfully', async () => {
      const mockResponse = {
        translations: {
          'welcome.title': 'Bienvenue',
          'welcome.subtitle': 'Bonjour'
        }
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await getTranslations('job_123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/translation_jobs/job_123/translations',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
          }
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getUpdates', () => {
    it('should fetch translation updates with valid parameters', async () => {
      const mockResponse = {
        updates: {
          timestamp: '2024-03-15T14:30:00Z',
          files: [
            {
              path: 'config/locales/fr.yml',
              languages: [
                {
                  code: 'fr',
                  translations: [
                    {
                      key: 'welcome.title',
                      value: 'Bienvenue',
                      updated_at: '2024-03-15T14:25:00Z'
                    }
                  ]
                }
              ]
            }
          ]
        },
        pagination: {
          current_page: 1,
          total_pages: 1,
          total_count: 1
        }
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const projectId = 'test-project';
      const since = '2024-03-15T00:00:00Z';
      const result = await getUpdates(projectId, { since });
      const expectedUrl = `https://api.localhero.ai/api/v1/projects/${projectId}/updates?since=${encodeURIComponent(since)}&page=1`;

      expect(global.fetch).toHaveBeenCalledWith(
        expectedUrl,
        {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678',
            'Content-Type': 'application/json'
          }
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when since parameter is missing', async () => {
      const projectId = 'test-project';
      await expect(getUpdates(projectId, {}))
        .rejects
        .toThrow('Missing required parameter: since (ISO 8601 timestamp)');
    });
  });
});