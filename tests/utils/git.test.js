import { jest } from '@jest/globals';
import { gitService, updateGitignore, getCurrentBranch } from '../../src/utils/git.js';

describe('git module', () => {
    let mockFs;
    let mockPath;
    let mockExec;
    let originalConsole;

    beforeEach(() => {
        mockFs = {
            readFile: jest.fn(),
            appendFile: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined)
        };

        mockPath = {
            join: jest.fn((...args) => args.join('/'))
        };

        mockExec = jest.fn();

        gitService.setDependencies({
            fs: mockFs,
            path: mockPath,
            exec: mockExec
        });

        originalConsole = { ...console };
        console.log = jest.fn();
        console.warn = jest.fn();
        console.error = jest.fn();
        console.info = jest.fn();
    });

    afterEach(() => {
        global.console = originalConsole;
    });

    describe('updateGitignore', () => {
        it('returns false if gitignore already contains .localhero_key', async () => {
            mockFs.readFile.mockResolvedValue('node_modules\n.env\n.localhero_key\n');

            const result = await updateGitignore('/project');

            expect(result).toBe(false);
            expect(mockFs.readFile).toHaveBeenCalledWith('/project/.gitignore', 'utf8');
            expect(mockFs.appendFile).not.toHaveBeenCalled();
        });

        it('appends .localhero_key when gitignore exists without it', async () => {
            mockFs.readFile.mockResolvedValue('node_modules\n.env\n');

            const result = await updateGitignore('/project');

            expect(result).toBe(true);
            expect(mockFs.readFile).toHaveBeenCalledWith('/project/.gitignore', 'utf8');
            expect(mockFs.appendFile).toHaveBeenCalledWith('/project/.gitignore', '\n.localhero_key\n');
        });

        it('creates gitignore when it does not exist', async () => {
            const fileNotFoundError = new Error('File not found');
            fileNotFoundError.code = 'ENOENT';
            mockFs.readFile.mockRejectedValue(fileNotFoundError);

            mockFs.appendFile.mockRejectedValue(fileNotFoundError);

            const result = await updateGitignore('/project');

            expect(result).toBe(true);
            expect(mockFs.readFile).toHaveBeenCalledWith('/project/.gitignore', 'utf8');
            expect(mockFs.appendFile).toHaveBeenCalledWith('/project/.gitignore', '\n.localhero_key\n');
            expect(mockFs.writeFile).toHaveBeenCalledWith('/project/.gitignore', '.localhero_key\n');
        });

        it('returns false on file read error other than ENOENT', async () => {
            const permissionError = new Error('Permission denied');
            permissionError.code = 'EACCES';
            mockFs.readFile.mockRejectedValue(permissionError);

            const result = await updateGitignore('/project');

            expect(result).toBe(false);
            expect(mockFs.readFile).toHaveBeenCalledWith('/project/.gitignore', 'utf8');
            expect(mockFs.appendFile).not.toHaveBeenCalled();
        });

        it('returns false on write error', async () => {
            mockFs.readFile.mockResolvedValue('node_modules\n.env\n');

            const diskFullError = new Error('Disk full');
            mockFs.appendFile.mockRejectedValue(diskFullError);

            const result = await updateGitignore('/project');

            expect(result).toBe(false);
            expect(mockFs.readFile).toHaveBeenCalledWith('/project/.gitignore', 'utf8');
            expect(mockFs.appendFile).toHaveBeenCalledWith('/project/.gitignore', '\n.localhero_key\n');
        });

        it('returns false on writeFile error when appendFile fails with ENOENT', async () => {
            const fileNotFoundError = new Error('File not found');
            fileNotFoundError.code = 'ENOENT';
            mockFs.readFile.mockRejectedValue(fileNotFoundError);

            mockFs.appendFile.mockRejectedValue(fileNotFoundError);
            mockFs.writeFile.mockRejectedValue(new Error('Failed to write file'));

            const result = await updateGitignore('/project');

            expect(result).toBe(false);
            expect(mockFs.writeFile).toHaveBeenCalledWith('/project/.gitignore', '.localhero_key\n');
        });
    });

    describe('getCurrentBranch', () => {
        it('returns branch name when git command succeeds', async () => {
            mockExec.mockResolvedValue({ stdout: 'main\n' });

            const result = await getCurrentBranch();

            expect(result).toBe('main');
            expect(mockExec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        });

        it('returns null when git command fails', async () => {
            mockExec.mockRejectedValue(new Error('Not a git repository'));

            const result = await getCurrentBranch();

            expect(result).toBe(null);
            expect(mockExec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        });
    });
});