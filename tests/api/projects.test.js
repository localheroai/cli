import { jest } from '@jest/globals';

const TEST_API_KEY = 'tk_123456789012345678901234567890123456789012345678';

describe('projects API', () => {
  let mockGetApiKey;
  let mockApiRequest;
  let listProjects;
  let createProject;

  beforeEach(async () => {
    jest.resetModules();

    mockGetApiKey = jest.fn().mockResolvedValue(TEST_API_KEY);
    mockApiRequest = jest.fn();

    await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
      getApiKey: mockGetApiKey
    }));

    await jest.unstable_mockModule('../../src/api/client.js', () => ({
      apiRequest: mockApiRequest
    }));

    const projectsModule = await import('../../src/api/projects.js');
    listProjects = projectsModule.listProjects;
    createProject = projectsModule.createProject;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listProjects', () => {
    it('fetches projects list successfully', async () => {
      const mockResponse = {
        projects: [
          {
            id: 'proj_123',
            name: 'Test Project',
            source_language: 'en',
            target_languages: ['fr', 'es']
          }
        ]
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await listProjects();

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects',
        {
          apiKey: TEST_API_KEY
        }
      );
      expect(result).toEqual(mockResponse.projects);
    });

    it('handles API errors', async () => {
      mockApiRequest.mockRejectedValueOnce(new Error('Failed to fetch projects'));

      await expect(listProjects())
        .rejects
        .toThrow('Failed to fetch projects');
    });
  });

  describe('createProject', () => {
    it('creates a project successfully', async () => {
      const projectData = {
        name: 'New Project',
        sourceLocale: 'en',
        targetLocales: ['fr', 'es']
      };
      const mockResponse = {
        project: {
          id: 'proj_123',
          name: projectData.name,
          source_language: projectData.sourceLocale,
          target_languages: projectData.targetLocales
        }
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await createProject(projectData);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects',
        {
          method: 'POST',
          body: {
            project: {
              name: projectData.name,
              source_language: projectData.sourceLocale,
              target_languages: projectData.targetLocales
            }
          },
          apiKey: TEST_API_KEY
        }
      );
      expect(result).toEqual(mockResponse.project);
    });

    it('handles project creation errors', async () => {
      const projectData = {
        name: 'New Project',
        sourceLocale: 'en',
        targetLocales: ['fr', 'es']
      };

      mockApiRequest.mockRejectedValueOnce(new Error('Project creation failed'));

      await expect(createProject(projectData))
        .rejects
        .toThrow('Project creation failed');
    });

    it('sends custom_languages when customLocales are provided', async () => {
      const projectData = {
        name: 'x',
        sourceLocale: 'en',
        targetLocales: ['ja', 'ja_easy'],
        customLocales: [{ code: 'ja_easy', name: 'Easy Japanese', baseLanguage: 'ja' }]
      };
      const mockResponse = {
        project: {
          id: 'proj_456',
          name: 'x',
          source_language: 'en',
          target_languages: ['ja', 'ja_easy']
        }
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      await createProject(projectData);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects',
        {
          method: 'POST',
          body: {
            project: {
              name: 'x',
              source_language: 'en',
              target_languages: ['ja', 'ja_easy'],
              custom_languages: [{ code: 'ja_easy', name: 'Easy Japanese', base_language: 'ja' }]
            }
          },
          apiKey: TEST_API_KEY
        }
      );
    });

    it('omits custom_languages key when no customLocales provided', async () => {
      const projectData = {
        name: 'Standard Project',
        sourceLocale: 'en',
        targetLocales: ['fr', 'es']
      };
      const mockResponse = {
        project: {
          id: 'proj_789',
          name: 'Standard Project',
          source_language: 'en',
          target_languages: ['fr', 'es']
        }
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      await createProject(projectData);

      const callArgs = mockApiRequest.mock.calls[0][1];
      expect(callArgs.body.project).not.toHaveProperty('custom_languages');
    });
  });
});