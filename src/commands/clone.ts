import { cloneService as defaultCloneService } from '../utils/clone-service.js';
import chalk from 'chalk';

interface CloneDependencies {
  cloneService: {
    cloneProject: (verbose?: boolean, force?: boolean) => Promise<{
      totalFiles: number;
      downloadedFiles: number;
      failedFiles: string[];
    }>;
  };
}

interface CloneOptions {
  verbose?: boolean;
  force?: boolean;
}

interface CloneResult {
  totalFiles: number;
  downloadedFiles: number;
  failedFiles: string[];
}

export async function clone(
  options: CloneOptions = {},
  deps: CloneDependencies = { cloneService: defaultCloneService }
): Promise<CloneResult | void> {
  const { verbose = false, force = false } = options;
  const { cloneService } = deps;

  if (verbose) {
    console.log(chalk.blue('Starting clone...'));
  }

  const result = await cloneService.cloneProject(verbose, force);

  if (!verbose) {
    if (result.failedFiles.length > 0) {
      console.log(chalk.yellow(`⚠️  ${result.failedFiles.length} files failed to download`));
    }

    if (result.downloadedFiles === result.totalFiles) {
      console.log(chalk.green(`✓ Clone completed - ${result.downloadedFiles} files downloaded`));
    }
  }

  return result;
}