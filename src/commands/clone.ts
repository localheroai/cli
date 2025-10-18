import { cloneService as defaultCloneService } from '../utils/clone-service.js';
import { configService } from '../utils/config.js';
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
  const { findTranslationFiles } = await import('../utils/files.js');
  const config = await configService.getProjectConfig();

  // Check if project uses .po/.pot files, we don't support cloning them yet
  if (config?.translationFiles?.pattern?.includes('.po') || config?.translationFiles?.pattern?.includes('.pot')) {
    const files = await findTranslationFiles(config, { parseContent: false, includeContent: false, extractKeys: false });
    const hasPoFiles = Array.isArray(files) ? files.some(file => file.path.endsWith('.po') || file.path.endsWith('.pot')) : false;

    if (hasPoFiles) {
      console.log(chalk.yellow('⚠️  Clone command is not yet supported for .po/.pot (gettext) files.'));
      console.log(chalk.gray('   Use the translate and pull commands instead.'));
      return;
    }
  }

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