import { jest } from '@jest/globals';

describe('cloneService', () => {
    let mockConfigService;
    let mockCloneApi;
    let mockConsole;
    let cloneService;
    let originalConsole;

    beforeEach(async () => {
        jest.resetModules();

        mockConfigService = {
            getValidProjectConfig: jest.fn()
        };

        mockCloneApi = {
            requestClone: jest.fn(),
            downloadFile: jest.fn()
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

        await jest.unstable_mockModule('../../src/api/clone.js', () => mockCloneApi);

        const cloneServiceModule = await import('../../src/utils/clone-service.js');
        cloneService = cloneServiceModule.cloneService;
    });

    afterEach(() => {
        global.console = originalConsole;
    });

    describe('cloneProject', () => {
        const testConfig = {
            projectId: 'test-project'
        };

        it('clones project with immediate completion', async () => {
            mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

            const mockResponse = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    },
                    'public/locales/navigation.json': {
                        url: 'https://s3.amazonaws.com/bucket/file2.json',
                        language: 'sv',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            mockCloneApi.requestClone.mockResolvedValue(mockResponse);
            mockCloneApi.downloadFile.mockResolvedValue(undefined);

            const result = await cloneService.cloneProject(true, false);

            expect(mockCloneApi.requestClone).toHaveBeenCalledWith('test-project');
            expect(mockCloneApi.downloadFile).toHaveBeenCalledTimes(2);
            expect(result).toEqual({
                totalFiles: 2,
                downloadedFiles: 2,
                failedFiles: []
            });
        });

        it('handles project not initialized error', async () => {
            mockConfigService.getValidProjectConfig.mockResolvedValue({});

            await expect(cloneService.cloneProject(false, false))
                .rejects
                .toThrow('Project not initialized. Please run `localhero init` first.');
        });

        it('handles API errors', async () => {
            mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);
            mockCloneApi.requestClone.mockRejectedValue(new Error('API Error'));

            await expect(cloneService.cloneProject(false, false))
                .rejects
                .toThrow('API Error');
        });
    });

    describe('pollForCompletion', () => {
        const testConfig = {
            projectId: 'test-project'
        };

        it('returns immediately when all files are completed', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            const result = await cloneService.pollForCompletion(response, true);

            expect(result).toEqual(response);
            expect(mockCloneApi.requestClone).not.toHaveBeenCalled();
        });

        it('polls until files are completed', async () => {
            mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

            const initialResponse = {
                files: {
                    'public/locales/common.json': {
                        url: null,
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'generating'
                    }
                },
                retryAfter: 1
            };

            const completedResponse = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            mockCloneApi.requestClone.mockResolvedValue(completedResponse);

            // Mock setTimeout to resolve immediately
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = jest.fn((callback) => callback());

            const result = await cloneService.pollForCompletion(initialResponse, true);

            expect(result).toEqual(completedResponse);
            expect(mockCloneApi.requestClone).toHaveBeenCalledWith('test-project');

            global.setTimeout = originalSetTimeout;
        });

        it('handles polling errors gracefully', async () => {
            mockConfigService.getValidProjectConfig.mockResolvedValue(testConfig);

            const initialResponse = {
                files: {
                    'public/locales/common.json': {
                        url: null,
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'generating'
                    }
                },
                retryAfter: 1
            };

            mockCloneApi.requestClone
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce({
                    files: {
                        'public/locales/common.json': {
                            url: 'https://s3.amazonaws.com/bucket/file1.json',
                            language: 'en',
                            format: 'json',
                            last_updated_at: '2025-01-22T14:30:00Z',
                            status: 'completed'
                        }
                    }
                });

            // Mock setTimeout to resolve immediately
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = jest.fn((callback) => callback());

            const result = await cloneService.pollForCompletion(initialResponse, true);

            expect(mockCloneApi.requestClone).toHaveBeenCalledTimes(2);
            expect(mockConsole.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to check status: Network error')
            );

            global.setTimeout = originalSetTimeout;
        });
    });

    describe('downloadFiles', () => {
        it('downloads all completed files successfully', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    },
                    'public/locales/navigation.json': {
                        url: 'https://s3.amazonaws.com/bucket/file2.json',
                        language: 'sv',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            mockCloneApi.downloadFile.mockResolvedValue(undefined);

            const result = await cloneService.downloadFiles(response, true, false);

            expect(mockCloneApi.downloadFile).toHaveBeenCalledTimes(2);
            expect(result).toEqual({
                totalFiles: 2,
                downloadedFiles: 2,
                failedFiles: []
            });
        });

        it('handles failed file generation', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: null,
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'failed'
                    }
                }
            };

            const result = await cloneService.downloadFiles(response, true, false);

            expect(mockCloneApi.downloadFile).not.toHaveBeenCalled();
            expect(result).toEqual({
                totalFiles: 1,
                downloadedFiles: 0,
                failedFiles: ['public/locales/common.json']
            });
        });

        it('handles files still generating', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: null,
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'generating'
                    }
                }
            };

            const result = await cloneService.downloadFiles(response, true, false);

            expect(mockCloneApi.downloadFile).not.toHaveBeenCalled();
            expect(result).toEqual({
                totalFiles: 1,
                downloadedFiles: 0,
                failedFiles: ['public/locales/common.json']
            });
        });

        it('handles download failures with retry', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            mockCloneApi.downloadFile
                .mockRejectedValueOnce(new Error('Network error'))
                .mockRejectedValueOnce(new Error('Network error'))
                .mockRejectedValueOnce(new Error('Network error'));

            // Mock setTimeout to resolve immediately
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = jest.fn((callback) => callback());

            const result = await cloneService.downloadFiles(response, true, false);

            expect(mockCloneApi.downloadFile).toHaveBeenCalledTimes(3);
            expect(result).toEqual({
                totalFiles: 1,
                downloadedFiles: 0,
                failedFiles: ['public/locales/common.json']
            });

            global.setTimeout = originalSetTimeout;
        });

        it('handles mixed success and failure scenarios', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    },
                    'public/locales/navigation.json': {
                        url: 'https://s3.amazonaws.com/bucket/file2.json',
                        language: 'sv',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    },
                    'public/locales/failed.json': {
                        url: null,
                        language: 'fr',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'failed'
                    }
                }
            };

            mockCloneApi.downloadFile
                .mockResolvedValueOnce(undefined) // First file succeeds
                .mockRejectedValue(new Error('Download failed')); // Second file fails

            // Mock setTimeout to resolve immediately
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = jest.fn((callback) => callback());

            const result = await cloneService.downloadFiles(response, true, false);

            expect(result.totalFiles).toBe(3);
            expect(result.downloadedFiles).toBe(1);
            expect(result.failedFiles).toHaveLength(2);
            expect(result.failedFiles).toContain('public/locales/navigation.json');
            expect(result.failedFiles).toContain('public/locales/failed.json');

            global.setTimeout = originalSetTimeout;
        });

        it('handles files with no URL', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: null,
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            const result = await cloneService.downloadFiles(response, true, false);

            expect(mockCloneApi.downloadFile).not.toHaveBeenCalled();
            expect(result).toEqual({
                totalFiles: 1,
                downloadedFiles: 0,
                failedFiles: ['public/locales/common.json']
            });
        });

        it('handles force flag to overwrite existing files', async () => {
            const response = {
                files: {
                    'public/locales/common.json': {
                        url: 'https://s3.amazonaws.com/bucket/file1.json',
                        language: 'en',
                        format: 'json',
                        last_updated_at: '2025-01-22T14:30:00Z',
                        status: 'completed'
                    }
                }
            };

            // Mock fs.access to simulate file exists
            const mockFs = await import('fs/promises');
            const originalAccess = mockFs.default.access;
            mockFs.default.access = jest.fn().mockResolvedValue(undefined);

            mockCloneApi.downloadFile.mockResolvedValue(undefined);

            const result = await cloneService.downloadFiles(response, true, true);

            expect(mockCloneApi.downloadFile).toHaveBeenCalledTimes(1);
            expect(result).toEqual({
                totalFiles: 1,
                downloadedFiles: 1,
                failedFiles: []
            });

            // Restore original fs.access
            mockFs.default.access = originalAccess;
        });
    });
});