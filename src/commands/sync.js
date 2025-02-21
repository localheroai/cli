import { syncService as defaultSyncService } from '../utils/sync-service.js';

export async function sync({ verbose = false } = {}, deps = { syncService: defaultSyncService }) {
    const { syncService } = deps;
    const { hasUpdates, updates } = await syncService.checkForUpdates({ verbose });

    if (!hasUpdates) {
        return;
    }

    await syncService.applyUpdates(updates, { verbose });
} 