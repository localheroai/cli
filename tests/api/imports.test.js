import { jest } from '@jest/globals';

const TEST_API_KEY = 'tk_123456789012345678901234567890123456789012345678';

describe('imports API', () => {
  let mockGetApiKey;
  let mockApiRequest;
  let createImport;
  let checkImportStatus;

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

    const importsModule = await import('../../src/api/imports.js');
    createImport = importsModule.createImport;
    checkImportStatus = importsModule.checkImportStatus;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createImport', () => {
    it('creates an import successfully', async () => {
      const projectId = 'proj_123';
      const translations = {
        'en.welcome.title': {
          value: 'Welcome',
          description: 'Welcome message on homepage'
        }
      };
      const mockResponse = {
        import: {
          id: 'imp_123',
          status: 'pending',
          total_strings: 1,
          processed_strings: 0,
          created_at: '2024-03-15T14:30:00Z'
        }
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await createImport({ projectId, translations });

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects/proj_123/imports',
        {
          method: 'POST',
          body: JSON.stringify({ translations }),
          apiKey: TEST_API_KEY
        }
      );
      expect(result.import).toEqual(mockResponse.import);
    });

    it('handles import creation errors', async () => {
      const projectId = 'proj_123';
      const translations = {};

      mockApiRequest.mockRejectedValueOnce(new Error('No translations provided'));

      await expect(createImport({ projectId, translations }))
        .rejects.toThrow('No translations provided');
    });
  });

  describe('checkImportStatus', () => {
    it('checks import status successfully', async () => {
      const projectId = 'proj_123';
      const importId = 'imp_123';

      const mockResponse = {
        import: {
          id: importId,
          status: 'completed',
          total_strings: 1,
          processed_strings: 1,
          created_at: '2024-03-15T14:30:00Z',
          completed_at: '2024-03-15T14:31:00Z'
        }
      };

      mockApiRequest.mockResolvedValueOnce(mockResponse);

      const result = await checkImportStatus(projectId, importId);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/v1/projects/proj_123/imports/imp_123',
        {
          apiKey: TEST_API_KEY
        }
      );
      expect(result).toEqual(mockResponse.import);
    });

    it('handles status check errors', async () => {
      const projectId = 'proj_123';
      const importId = 'invalid_import';

      mockApiRequest.mockRejectedValueOnce(new Error('Import not found'));

      await expect(checkImportStatus(projectId, importId))
        .rejects.toThrow('Import not found');
    });
  });
});