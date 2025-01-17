import { syncService } from '../utils/sync-service.js';

export async function sync({ verbose = false } = {}) {
    const { hasUpdates, updates } = await syncService.checkForUpdates({ verbose });

    if (!hasUpdates) {
        return;
    }

    await syncService.applyUpdates(updates, { verbose });
} 