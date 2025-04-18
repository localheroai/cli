import { jest } from '@jest/globals';
import { configService } from '../../src/utils/config.js';

describe('config module', () => {
    let mockFs;
    let mockPath;
    let mockCwd;
    let testDate;
    let originalConsole;

    beforeEach(() => {
        mockFs = {
            readFile: jest.fn(),
            writeFile: jest.fn().mockResolvedValue(undefined)
        };

        mockPath = {
            join: jest.fn((...args) => args.join('/'))
        };

        mockCwd = jest.fn().mockReturnValue('/test/project');

        testDate = new Date('2023-01-01T00:00:00Z');
        global.Date = jest.fn(() => testDate);
        global.Date.toISOString = testDate.toISOString;
        global.Date.now = jest.fn(() => testDate.getTime());

        configService.setDependencies({
            fs: mockFs,
            path: mockPath,
            cwd: mockCwd
        });

        originalConsole = { ...console };
        console.log = jest.fn();
        console.warn = jest.fn();
        console.error = jest.fn();
        console.info = jest.fn();
    });

    afterEach(() => {
        global.console = originalConsole;
        jest.restoreAllMocks();
    });

    describe('configFilePath', () => {
        it('returns path to localhero.json in current working directory when no basePath provided', () => {
            const result = configService.configFilePath();
            expect(result).toBe('/test/project/localhero.json');
            expect(mockPath.join).toHaveBeenCalledWith('/test/project', 'localhero.json');
        });

        it('returns path to localhero.json in specified base directory', () => {
            const result = configService.configFilePath('/custom/path');
            expect(result).toBe('/custom/path/localhero.json');
            expect(mockPath.join).toHaveBeenCalledWith('/custom/path', 'localhero.json');
        });
    });

    describe('getAuthConfig', () => {
        it('returns parsed config when file exists', async () => {
            const mockConfig = { apiKey: 'test-key' };
            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await configService.getAuthConfig();

            expect(result).toEqual(mockConfig);
            expect(mockFs.readFile).toHaveBeenCalledWith('/test/project/.localhero_key', 'utf8');
        });

        it('returns null when file does not exist', async () => {
            mockFs.readFile.mockRejectedValue(new Error('File not found'));

            const result = await configService.getAuthConfig();

            expect(result).toBeNull();
        });

        it('uses provided basePath', async () => {
            mockFs.readFile.mockRejectedValue(new Error('File not found'));

            await configService.getAuthConfig('/custom/path');

            expect(mockPath.join).toHaveBeenCalledWith('/custom/path', '.localhero_key');
        });
    });

    describe('saveAuthConfig', () => {
        it('writes config to .localhero_key file with correct permissions', async () => {
            const mockConfig = { apiKey: 'test-key' };

            await configService.saveAuthConfig(mockConfig);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/test/project/.localhero_key',
                JSON.stringify(mockConfig, null, 2),
                { mode: 0o600 }
            );
        });

        it('uses provided basePath', async () => {
            const mockConfig = { apiKey: 'test-key' };

            await configService.saveAuthConfig(mockConfig, '/custom/path');

            expect(mockPath.join).toHaveBeenCalledWith('/custom/path', '.localhero_key');
        });
    });

    describe('getProjectConfig', () => {
        it('returns parsed config when file exists and schema matches', async () => {
            const mockConfig = {
                schemaVersion: '1.0',
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr', 'de'],
                translationFiles: {
                    paths: ['locales'],
                    ignore: []
                }
            };
            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await configService.getProjectConfig();

            expect(result).toEqual(mockConfig);
            expect(mockFs.readFile).toHaveBeenCalledWith('/test/project/localhero.json', 'utf8');
        });

        it('returns null when file does not exist', async () => {
            const error = new Error('File not found');
            error.code = 'ENOENT';
            mockFs.readFile.mockRejectedValue(error);

            const result = await configService.getProjectConfig();

            expect(result).toBeNull();
        });

        it('throws on other file errors', async () => {
            const error = new Error('Permission denied');
            error.code = 'EACCES';
            mockFs.readFile.mockRejectedValue(error);

            await expect(configService.getProjectConfig()).rejects.toThrow('Permission denied');
        });
    });

    describe('saveProjectConfig', () => {
        it('saves config with schema version and default values', async () => {
            const inputConfig = {
                projectId: 'test-project',
                outputLocales: ['fr']
            };

            await configService.saveProjectConfig(inputConfig);

            const savedConfig = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
            expect(savedConfig).toEqual({
                schemaVersion: '1.0',
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: [],
                    ignore: []
                },
                lastSyncedAt: null
            });
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/test/project/localhero.json',
                expect.any(String)
            );
        });

        it('uses provided basePath', async () => {
            const inputConfig = { projectId: 'test-project' };

            await configService.saveProjectConfig(inputConfig, '/custom/path');

            expect(mockPath.join).toHaveBeenCalledWith('/custom/path', 'localhero.json');
        });
    });

    describe('validateProjectConfig', () => {
        it('returns true for valid config', async () => {
            const validConfig = {
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: ['locales']
                }
            };

            const result = await configService.validateProjectConfig(validConfig);

            expect(result).toBe(true);
        });

        it('throws when required fields are missing', async () => {
            const invalidConfig = {
                sourceLocale: 'en',
                outputLocales: ['fr']
            };

            await expect(configService.validateProjectConfig(invalidConfig))
                .rejects.toThrow(/Missing required config: projectId, translationFiles/);
        });

        it('throws when outputLocales is not an array or empty', async () => {
            const invalidConfig = {
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: [],
                translationFiles: {
                    paths: ['locales']
                }
            };

            await expect(configService.validateProjectConfig(invalidConfig))
                .rejects.toThrow('outputLocales must be an array with at least one locale');
        });

        it('throws when translationFiles.paths is not an array', async () => {
            const invalidConfig = {
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: 'locales'
                }
            };

            await expect(configService.validateProjectConfig(invalidConfig))
                .rejects.toThrow('translationFiles.paths must be an array of paths');
        });
    });

    describe('getValidProjectConfig', () => {
        it('returns validated config when it exists', async () => {
            const mockConfig = {
                schemaVersion: '1.0',
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: ['locales'],
                    ignore: []
                }
            };

            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await configService.getValidProjectConfig();

            expect(result).toEqual(mockConfig);
        });

        it('throws when no config exists', async () => {
            const error = new Error('File not found');
            error.code = 'ENOENT';
            mockFs.readFile.mockRejectedValue(error);

            await expect(configService.getValidProjectConfig())
                .rejects.toThrow('No project config found');
        });

        it('throws when config is invalid', async () => {
            const invalidConfig = {
                schemaVersion: '1.0',
                projectId: 'test-project'
            };

            mockFs.readFile.mockResolvedValue(JSON.stringify(invalidConfig));

            await expect(configService.getValidProjectConfig())
                .rejects.toThrow(/Missing required config/);
        });
    });

    describe('updateLastSyncedAt', () => {
        it('updates lastSyncedAt in config and saves it', async () => {
            const mockConfig = {
                schemaVersion: '1.0',
                projectId: 'test-project',
                sourceLocale: 'en',
                outputLocales: ['fr'],
                translationFiles: {
                    paths: ['locales'],
                    ignore: []
                },
                lastSyncedAt: null
            };

            mockFs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

            const result = await configService.updateLastSyncedAt();

            expect(result.lastSyncedAt).toBe('2023-01-01T00:00:00.000Z');
            expect(mockFs.writeFile).toHaveBeenCalled();

            const savedConfig = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
            expect(savedConfig.lastSyncedAt).toBe('2023-01-01T00:00:00.000Z');
        });
    });
});