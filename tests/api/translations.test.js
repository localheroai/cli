import { jest } from '@jest/globals';

const TEST_API_KEY = 'tk_123456789012345678901234567890123456789012345678';

describe('translations API', () => {
  let mockGetApiKey;
  let mockGetCurrentBranch;
  let mockApiRequest;
  let getUpdates;
  let createTranslationJob;
  let checkJobStatus;
  let getTranslations;

  beforeEach(async () => {
    jest.resetModules();

    mockGetApiKey = jest.fn().mockResolvedValue(TEST_API_KEY);
    mockGetCurrentBranch = jest.fn().mockResolvedValue(null);
    mockApiRequest = jest.fn();

    await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
      getApiKey: mockGetApiKey
    }));
    await jest.unstable_mockModule('../../src/utils/git.js', () => ({
      getCurrentBranch: mockGetCurrentBranch
    }));
    await jest.unstable_mockModule('../../src/api/client.js', () => ({
      apiRequest: mockApiRequest
    }));

    const translationsModule = await import('../../src/api/translations.js');
    getUpdates = translationsModule.getUpdates;
    createTranslationJob = translationsModule.createTranslationJob;
    checkJobStatus = translationsModule.checkJobStatus;
    getTranslations = translationsModule.getTranslations;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createTranslationJob', () => {
    it('creates translation job successfully', async () => {
      const branchName = 'feature/test-branch';
      mockGetCurrentBranch.mockResolvedValueOnce(branchName);

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

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const projectId = 'proj_123';
      const sourceFiles = [{
        path: 'locales/en.yml',
        content: 'content123',
        format: 'yaml'
      }];
      const targetLocales = ['fr'];

      const result = await createTranslationJob({ projectId, sourceFiles, targetLocales });

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects/proj_123/translation_jobs',
        {
          method: 'POST',
          body: JSON.stringify({
            target_languages: targetLocales,
            files: sourceFiles.map(file => ({
              path: file.path,
              content: file.content,
              format: file.format,
              target_paths: undefined
            })),
            branch: branchName
          }),
          apiKey: TEST_API_KEY
        }
      );
      expect(result).toEqual({
        jobs: mockResponse.jobs,
        totalJobs: 1
      });
    });

    it('handles empty jobs response', async () => {
      mockApiRequest.mockResolvedValueOnce({ jobs: [] });

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

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await checkJobStatus('job_123');

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/translation_jobs/job_123',
        { apiKey: TEST_API_KEY }
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

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await checkJobStatus('job_123', true);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/translation_jobs/job_123?include_translations=true',
        { apiKey: TEST_API_KEY }
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

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await getTranslations('job_123');

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/translation_jobs/job_123/translations',
        { apiKey: TEST_API_KEY }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getUpdates', () => {
    it('fetches translation updates with valid parameters', async () => {
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

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const projectId = 'test-project';
      const since = '2024-03-15T00:00:00Z';
      const result = await getUpdates(projectId, { since });

      expect(mockApiRequest).toHaveBeenCalledWith(
        `/api/v1/projects/${projectId}/updates?since=${encodeURIComponent(since)}&page=1`,
        { apiKey: TEST_API_KEY }
      );
      expect(result).toEqual(mockResponse);
    });

    it('throws error when since parameter is missing', async () => {
      const projectId = 'test-project';
      await expect(getUpdates(projectId, {}))
        .rejects
        .toThrow('Missing required parameter: since (ISO 8601 timestamp)');
    });
  });
});