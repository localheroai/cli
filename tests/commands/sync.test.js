import { jest } from '@jest/globals';
import { sync } from '../../src/commands/sync.js';

global.fetch = jest.fn();
global.console = { log: jest.fn(), error: jest.fn() };

describe('sync command', () => {
  const mockSyncService = {
    checkForUpdates: jest.fn(),
    applyUpdates: jest.fn()
  };

  function createSyncDeps(overrides = {}) {
    return {
      syncService: mockSyncService,
      ...overrides
    };
  }

  beforeEach(() => {
    global.fetch.mockReset();
    global.console.log.mockReset();
    global.console.error.mockReset();
    mockSyncService.checkForUpdates.mockReset();
    mockSyncService.applyUpdates.mockReset();
  });

  it('handles case when no updates are available', async () => {
    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: false,
      updates: []
    });

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: [] })
    });

    await sync({}, createSyncDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: false });
    expect(mockSyncService.applyUpdates).not.toHaveBeenCalled();
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('All translations are up to date'));
  });

  it('syncs updates when available', async () => {
    const mockUpdates = [
      { key: 'test.key', value: 'new value' }
    ];

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: mockUpdates })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 1,
      totalDeleted: 0
    });

    const result = await sync({}, createSyncDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: false });
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, { verbose: false });
    expect(result).toEqual({ totalUpdates: 1, totalDeleted: 0 });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Updated 1 translations'));
  });

  it('handles deleted keys', async () => {
    const mockUpdates = {
      updates: {
        files: [],
        deleted_keys: [
          { name: 'deprecated.feature', deleted_at: '2024-03-14T11:50:00Z' }
        ]
      }
    };

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 0,
      totalDeleted: 1
    });

    const result = await sync({}, createSyncDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: false });
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, { verbose: false });
    expect(result).toEqual({ totalUpdates: 0, totalDeleted: 1 });
    expect(global.console.log).toHaveBeenCalledWith(expect.stringContaining('Deleted 1 keys'));
  });

  it('supports verbose flag', async () => {
    const mockUpdates = [
      { key: 'test.key', value: 'new value' }
    ];

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updates: mockUpdates })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: mockUpdates
    });

    mockSyncService.applyUpdates.mockResolvedValue({
      totalUpdates: 1,
      totalDeleted: 0
    });

    await sync({ verbose: true }, createSyncDeps());

    expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: true });
    expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, { verbose: true });
  });

  it('propagates errors during update check', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Network error' } })
    });

    mockSyncService.checkForUpdates.mockRejectedValue(new Error('Network error'));

    await expect(sync({}, createSyncDeps()))
      .rejects
      .toThrow('Network error');
  });

  it('propagates invalid API key errors', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: {
          code: 'invalid_api_key',
          message: 'Invalid API key'
        }
      })
    });

    mockSyncService.checkForUpdates.mockRejectedValue(new Error('Your API key is invalid or has been revoked'));

    await expect(sync({}, createSyncDeps()))
      .rejects
      .toThrow('Your API key is invalid or has been revoked');
  });

  it('propagates errors during updates', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updates: [{ key: 'test.key', value: 'new value' }]
      })
    });

    mockSyncService.checkForUpdates.mockResolvedValue({
      hasUpdates: true,
      updates: [{ key: 'test.key', value: 'new value' }]
    });
    mockSyncService.applyUpdates.mockRejectedValue(new Error('Failed to apply updates'));

    await expect(sync({}, createSyncDeps()))
      .rejects
      .toThrow('Failed to apply updates');
  });
});