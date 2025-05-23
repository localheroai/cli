import { jest } from '@jest/globals';

const TEST_API_KEY = 'tk_123456789012345678901234567890123456789012345678';

describe('clone API', () => {
    let mockGetApiKey;
    let mockApiRequest;
    let mockFs;
    let mockFetch;
    let requestClone;
    let downloadFile;
    let parseCloneResponse;

    beforeEach(async () => {
        jest.resetModules();

        mockGetApiKey = jest.fn().mockResolvedValue(TEST_API_KEY);
        mockApiRequest = jest.fn();
        mockFs = {
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined)
        };
        mockFetch = jest.fn();

        global.fetch = mockFetch;

        await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
            getApiKey: mockGetApiKey
        }));
        await jest.unstable_mockModule('../../src/api/client.js', () => ({
            apiRequest: mockApiRequest
        }));
        await jest.unstable_mockModule('fs/promises', () => mockFs);

        const cloneModule = await import('../../src/api/clone.js');
        requestClone = cloneModule.requestClone;
        downloadFile = cloneModule.downloadFile;
        parseCloneResponse = cloneModule.parseCloneResponse;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    describe('parseCloneResponse', () => {
        it('parses response with files and retry_after', () => {
            const rawResponse = {
                'public/locales/common.json': {
                    url: 'https://s3.amazonaws.com/bucket/file1.json',
                    language: 'en',
                    format: 'json',
                    last_updated_at: '2025-01-22T14:30:00Z',
                    status: 'completed'
                },
                'public/locales/navigation.json': {
                    url: null,
                    language: 'sv',
                    format: 'json',
                    last_updated_at: '2025-01-22T14:30:00Z',
                    status: 'generating'
                },
                retry_after: 5
            };

            const result = parseCloneResponse(rawResponse);

            expect(result).toEqual({
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    },
                    'public/locales/navigation.json': {
                        url: null,
                        language: 'sv',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'generating'
                    }
                },
                retryAfter: 5
            });
        });

        it('parses response without retry_after', () => {
            const rawResponse = {
                'public/locales/common.json': {
                    url: 'https://s3.amazonaws.com/bucket/file1.json',
                    language: 'en',
                    format: 'json',
                    last_updated_at: '2025-01-22T14:30:00Z',
                    status: 'completed'
                }
            };

            const result = parseCloneResponse(rawResponse);

            expect(result).toEqual({
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                },
                retryAfter: undefined
            });
        });

        it('handles empty response', () => {
            const result = parseCloneResponse({});
            expect(result).toEqual({
                files: {},
                retryAfter: undefined
            });
        });
    });

    describe('requestClone', () => {
        it('requests clone successfully', async () => {
            const mockResponse = {
                'public/locales/common.json': {
                    url: 'https://s3.amazonaws.com/bucket/file1.json',
                    language: 'en',
                    format: 'json',
                    last_updated_at: '2025-01-22T14:30:00Z',
                    status: 'completed'
                }
            };

            mockApiRequest.mockResolvedValueOnce(mockResponse);

            const result = await requestClone('proj_123');

            expect(mockApiRequest).toHaveBeenCalledWith(
                '/api/v1/projects/proj_123/clone',
                { apiKey: TEST_API_KEY }
            );
            expect(result.files).toEqual(mockResponse);
            expect(result.retryAfter).toBeUndefined();
        });

        it('requests clone with retry_after successfully', async () => {
            const mockResponse = {
                'config/locales/en.yml': {
                    url: 'https://s3.amazonaws.com/bucket/file1.yml',
                    language: 'en',
                    format: 'yaml',
                    last_updated_at: '2025-01-22T14:30:00Z',
                    status: 'completed'
                },
                retry_after: 3
            };

            mockApiRequest.mockResolvedValueOnce(mockResponse);

            const result = await requestClone('proj_123');

            expect(mockApiRequest).toHaveBeenCalledWith(
                '/api/v1/projects/proj_123/clone',
                { apiKey: TEST_API_KEY }
            );
            expect(result.files['config/locales/en.yml']).toEqual({
                url: 'https://s3.amazonaws.com/bucket/file1.yml',
                language: 'en',
                format: 'yaml',
                last_updated_at: '2025-01-22T14:30:00Z',
                status: 'completed'
            });
            expect(result.retryAfter).toBe(3);
        });

        it('propagates API errors', async () => {
            const apiError = new Error('Project not found');
            mockApiRequest.mockRejectedValueOnce(apiError);

            await expect(requestClone('proj_123'))
                .rejects
                .toThrow('Project not found');
        });
    });

    describe('downloadFile', () => {
        const mockPath = {
            dirname: jest.fn()
        };

        beforeEach(() => {
            mockPath.dirname.mockImplementation((filePath) => {
                const parts = filePath.split('/');
                return parts.slice(0, -1).join('/');
            });
        });

        it('downloads file successfully', async () => {
            const fileContent = '{"hello": "world"}';
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(fileContent)
            });

            await downloadFile('https://example.com/file.json', 'local/path/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            });

            expect(mockFetch).toHaveBeenCalledWith('https://example.com/file.json', {
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });
            expect(mockFs.mkdir).toHaveBeenCalledWith('local/path', { recursive: true });
            expect(mockFs.writeFile).toHaveBeenCalledWith('local/path/file.json', fileContent, 'utf8');
        });

        it('creates nested directories', async () => {
            const fileContent = 'content';
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(fileContent)
            });

            await downloadFile('https://example.com/file.json', 'deep/nested/path/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            });

            expect(mockFs.mkdir).toHaveBeenCalledWith('deep/nested/path', { recursive: true });
        });

        it('handles missing URL', async () => {
            await expect(downloadFile('', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('URL is required for file download');

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('handles fetch errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: 'Not Found'
            });

            await expect(downloadFile('https://example.com/missing.json', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('Failed to download file: 404 Not Found');
        });

        it('handles network errors', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            await expect(downloadFile('https://example.com/file.json', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('Failed to download file to local/file.json: Network error');
        });

        it('handles permission errors', async () => {
            const fileContent = 'content';
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(fileContent)
            });

            const permissionError = new Error('Permission denied');
            permissionError.code = 'EACCES';
            mockFs.writeFile.mockRejectedValueOnce(permissionError);

            await expect(downloadFile('https://example.com/file.json', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('Permission denied writing to local/file.json. Check file permissions.');
        });

        it('handles disk space errors', async () => {
            const fileContent = 'content';
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(fileContent)
            });

            const spaceError = new Error('No space left');
            spaceError.code = 'ENOSPC';
            mockFs.writeFile.mockRejectedValueOnce(spaceError);

            await expect(downloadFile('https://example.com/file.json', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('No space left on device when writing to local/file.json');
        });

        it('handles other file system errors', async () => {
            const fileContent = 'content';
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(fileContent)
            });

            const fsError = new Error('Unknown file system error');
            mockFs.writeFile.mockRejectedValueOnce(fsError);

            await expect(downloadFile('https://example.com/file.json', 'local/file.json', {
                fs: mockFs,
                path: mockPath,
                fetch: mockFetch
            }))
                .rejects
                .toThrow('Failed to download file to local/file.json: Unknown file system error');
        });
    });
});