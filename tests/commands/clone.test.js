import { jest } from '@jest/globals';
import { clone } from '../../src/commands/clone.js';

global.console = { log: jest.fn(), error: jest.fn() };

describe('clone command', () => {
  const mockCloneService = {
    cloneProject: jest.fn()
  };

  function createCloneDeps(overrides = {}) {
    return {
      cloneService: mockCloneService,
      ...overrides
    };
  }

  beforeEach(() => {
    global.console.log.mockReset();
    global.console.error.mockReset();
    mockCloneService.cloneProject.mockReset();
  });

  it('clones project with default settings', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 3,
      downloadedFiles: 3,
      failedFiles: []
    });

    const result = await clone({}, createCloneDeps());

    expect(mockCloneService.cloneProject).toHaveBeenCalledWith(false, false);
    expect(result).toEqual({
      totalFiles: 3,
      downloadedFiles: 3,
      failedFiles: []
    });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Clone completed - 3 files downloaded'));
  });

  it('handles partial failures', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 5,
      downloadedFiles: 3,
      failedFiles: ['file1.json', 'file2.json']
    });

    const result = await clone({}, createCloneDeps());

    expect(result).toEqual({
      totalFiles: 5,
      downloadedFiles: 3,
      failedFiles: ['file1.json', 'file2.json']
    });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('2 files failed to download'));
  });

  it('handles complete failure', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 2,
      downloadedFiles: 0,
      failedFiles: ['file1.json', 'file2.json']
    });

    const result = await clone({}, createCloneDeps());

    expect(result).toEqual({
      totalFiles: 2,
      downloadedFiles: 0,
      failedFiles: ['file1.json', 'file2.json']
    });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('2 files failed to download'));
    expect(global.console.log).not.toHaveBeenCalledWith(expect.stringContaining('Downloaded'));
  });

  it('supports verbose flag', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 1,
      downloadedFiles: 1,
      failedFiles: []
    });

    await clone({ verbose: true }, createCloneDeps());

    expect(mockCloneService.cloneProject).toHaveBeenCalledWith(true, false);
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Starting clone'));
  });

  it('supports force flag', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 2,
      downloadedFiles: 2,
      failedFiles: []
    });

    const result = await clone({ force: true }, createCloneDeps());

    expect(mockCloneService.cloneProject).toHaveBeenCalledWith(false, true);
    expect(result).toEqual({
      totalFiles: 2,
      downloadedFiles: 2,
      failedFiles: []
    });
  });

  it('supports both verbose and force flags', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 1,
      downloadedFiles: 1,
      failedFiles: []
    });

    await clone({ verbose: true, force: true }, createCloneDeps());

    expect(mockCloneService.cloneProject).toHaveBeenCalledWith(true, true);
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Starting clone'));
  });

  it('propagates service errors', async () => {
    mockCloneService.cloneProject.mockRejectedValue(new Error('Project not initialized'));

    await expect(clone({}, createCloneDeps()))
      .rejects
      .toThrow('Project not initialized');
  });

  it('propagates API errors', async () => {
    mockCloneService.cloneProject.mockRejectedValue(new Error('API Error: 401 Unauthorized'));

    await expect(clone({}, createCloneDeps()))
      .rejects
      .toThrow('API Error: 401 Unauthorized');
  });

  it('does not show summary in verbose mode', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 3,
      downloadedFiles: 3,
      failedFiles: []
    });

    await clone({ verbose: true }, createCloneDeps());

    // Should show the starting message but not the summary (service handles verbose output)
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Starting clone'));
    expect(global.console.log).not.toHaveBeenCalledWith(expect.stringContaining('Downloaded 3 files'));
    expect(global.console.log).not.toHaveBeenCalledWith(expect.stringContaining('Clone completed'));
  });

  it('handles empty result', async () => {
    mockCloneService.cloneProject.mockResolvedValue({
      totalFiles: 0,
      downloadedFiles: 0,
      failedFiles: []
    });

    const result = await clone({}, createCloneDeps());

    expect(result).toEqual({
      totalFiles: 0,
      downloadedFiles: 0,
      failedFiles: []
    });
    // Should not show any download messages for empty results
    expect(global.console.log).not.toHaveBeenCalledWith(expect.stringContaining('Downloaded'));
    expect(global.console.log).not.toHaveBeenCalledWith(expect.stringContaining('failed to download'));
  });
});