import { syncService as defaultSyncService } from '../utils/sync-service.js';
import chalk from 'chalk';

interface PullDependencies {
  syncService: {
    checkForUpdates: (verbose?: boolean) => Promise<{
      hasUpdates: boolean;
      updates?: any;
    }>;
    applyUpdates: (
      updates: any,
      verbose?: boolean
    ) => Promise<{
      totalUpdates: number;
      totalDeleted: number;
    }>;
  };
}

interface PullResult {
  totalUpdates: number;
  totalDeleted: number;
}

export async function pull(
  { verbose = false }: { verbose?: boolean } = {},
  deps: PullDependencies = { syncService: defaultSyncService }
): Promise<PullResult | void> {
  const { syncService } = deps;
  const { hasUpdates, updates } = await syncService.checkForUpdates(verbose);

  if (!hasUpdates) {
    console.log(chalk.green('✓ All translations are up to date'));
    return;
  }

  const result = await syncService.applyUpdates(updates, verbose);

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