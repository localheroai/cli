import { syncService as defaultSyncService } from '../utils/sync-service.js';
import chalk from 'chalk';

export async function sync({ verbose = false } = {}, deps = { syncService: defaultSyncService }) {
    const { syncService } = deps;

    const { hasUpdates, updates } = await syncService.checkForUpdates({ verbose });

    if (!hasUpdates) {
        console.log(chalk.green('✓ All translations are up to date'));
        return;
    }

    const result = await syncService.applyUpdates(updates, { verbose });

    const { totalUpdates = 0, totalDeleted = 0 } = result;

    if (!verbose) {
        if (totalUpdates > 0) {
            console.log(chalk.green(`✓ Updated ${totalUpdates} translations`));
        }

        if (totalDeleted > 0) {
            console.log(chalk.green(`✓ Deleted ${totalDeleted} keys`));
        }
    }

    return result;
} 