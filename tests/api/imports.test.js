import { jest } from '@jest/globals';

const TEST_API_KEY = 'tk_123456789012345678901234567890123456789012345678';

describe('imports API', () => {
  let mockGetApiKey;
  let createImport;
  let checkImportStatus;

  beforeEach(async () => {
    jest.resetModules();
    global.fetch = jest.fn();

    mockGetApiKey = jest.fn().mockResolvedValue(TEST_API_KEY);
    await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
      getApiKey: mockGetApiKey
    }));

    const importsModule = await import('../../src/api/imports.js');
    createImport = importsModule.createImport;
    checkImportStatus = importsModule.checkImportStatus;
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

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await createImport({ projectId, translations });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/projects/proj_123/imports',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_API_KEY}`
          },
          body: JSON.stringify({ translations })
        }
      );
      expect(result).toEqual(mockResponse.import);
    });

    it('handles import creation errors', async () => {
      const projectId = 'proj_123';
      const translations = {};

      const errorResponse = {
        error: {
          message: 'No translations provided'
        }
      };

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: () => Promise.resolve(errorResponse)
      });

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

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await checkImportStatus(projectId, importId);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.localhero.ai/api/v1/projects/proj_123/imports/imp_123',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_API_KEY}`
          }
        }
      );
      expect(result).toEqual(mockResponse.import);
    });

    it('handles status check errors', async () => {
      const projectId = 'proj_123';
      const importId = 'invalid_import';

      const errorResponse = {
        error: {
          message: 'Import not found'
        }
      };

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve(errorResponse)
      });

      await expect(checkImportStatus(projectId, importId))
        .rejects.toThrow('Import not found');
    });
  });
});