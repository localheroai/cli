import { jest } from '@jest/globals';
import { sync } from '../../src/commands/sync.js';

global.fetch = jest.fn();

describe('sync command', () => {
    const mockConsole = { log: jest.fn(), error: jest.fn() };
    const mockSyncService = {
        checkForUpdates: jest.fn(),
        applyUpdates: jest.fn()
    };

    function createSyncDeps(overrides = {}) {
        return {
            console: mockConsole,
            syncService: mockSyncService,
            ...overrides
        };
    }

    beforeEach(() => {
        global.fetch.mockReset();
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

        await sync({}, createSyncDeps());

        expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: false });
        expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, { verbose: false });
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

        await sync({ verbose: true }, createSyncDeps());

        expect(mockSyncService.checkForUpdates).toHaveBeenCalledWith({ verbose: true });
        expect(mockSyncService.applyUpdates).toHaveBeenCalledWith(mockUpdates, { verbose: true });
    });

    it('handles errors during update check', async () => {
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

    it('handles invalid API key errors', async () => {
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

    it('handles errors during updates', async () => {
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