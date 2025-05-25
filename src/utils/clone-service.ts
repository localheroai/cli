import chalk from 'chalk';
import fs from 'fs/promises';
import { configService } from './config.js';
import { requestClone, downloadFile, ParsedCloneResponse, CloneFileStatus } from '../api/clone.js';

// Clone result interface
export interface CloneResult {
  totalFiles: number;
  downloadedFiles: number;
  failedFiles: string[];
}

// Clone service interface
export interface CloneService {
  cloneProject(verbose?: boolean, force?: boolean): Promise<CloneResult>;
  pollForCompletion(response: ParsedCloneResponse, verbose?: boolean): Promise<ParsedCloneResponse>;
  downloadFiles(response: ParsedCloneResponse, verbose?: boolean, force?: boolean): Promise<CloneResult>;
}

// Default polling configuration
const DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_ATTEMPTS = 60; // 5 minutes total
const RETRY_DELAY_MS = 1000; // 1 second

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Download a file with retry
 */
async function downloadFileWithRetry(
  filePath: string,
  fileStatus: CloneFileStatus,
  maxRetries = 3,
  verbose = false
): Promise<boolean> {
  if (!fileStatus.url) {
    if (verbose) {
      console.log(chalk.yellow(`⚠️  No URL available for ${filePath}`));
    }
    return false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await downloadFile(fileStatus.url, filePath);
      if (verbose) {
        console.log(chalk.green(`✓ Downloaded ${filePath} (${fileStatus.language})`));
      }
      return true;
    } catch (error: any) {
      if (attempt === maxRetries) {
        console.error(chalk.red(`❌ Failed to download ${filePath} after ${maxRetries} attempts: ${error.message}`));
        return false;
      }

      if (verbose) {
        console.log(chalk.yellow(`⚠️  Download attempt ${attempt} failed for ${filePath}, retrying...`));
      }

      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  return false;
}

export const cloneService: CloneService = {
  /**
   * Clone all translations for a project
   * @param verbose Whether to show verbose output
   * @param force Whether to overwrite existing files
   * @returns Result with download statistics
   */
  async cloneProject(verbose = false, force = false): Promise<CloneResult> {
    const config = await configService.getValidProjectConfig();

    if (!config.projectId) {
      throw new Error('Project not initialized. Please run `localhero init` first.');
    }

    if (verbose) {
      console.log(chalk.blue(`Requesting clone for project ${config.projectId}...`));
    }

    // Request clone from API
    const response = await requestClone(config.projectId);

    if (verbose) {
      const fileCount = Object.keys(response.files).length;
      console.log(chalk.blue(`Found ${fileCount} files to clone`));
    }

    // Poll for completion if needed
    const completedResponse = await this.pollForCompletion(response, verbose);

    // Download all completed files
    return await this.downloadFiles(completedResponse, verbose, force);
  },

  /**
   * Poll the API until all files are ready for download
   * @param response Initial clone response
   * @param verbose Whether to show verbose output
   * @returns Updated response with completed files
   */
  async pollForCompletion(response: ParsedCloneResponse, verbose = false): Promise<ParsedCloneResponse> {
    let currentResponse = response;
    let pollAttempts = 0;

    while (pollAttempts < MAX_POLL_ATTEMPTS) {
      const pendingFiles = Object.entries(currentResponse.files).filter(
        ([, fileStatus]) => fileStatus.status === 'generating'
      );

      if (pendingFiles.length === 0) {
        // All files are ready
        break;
      }

      if (verbose) {
        console.log(chalk.blue(`⏳ ${pendingFiles.length} files still generating...`));
        for (const [filePath, fileStatus] of pendingFiles) {
          console.log(chalk.gray(`   ${filePath} (${fileStatus.language}) - ${fileStatus.status}`));
        }
      }

      const retryAfter = currentResponse.retryAfter || DEFAULT_POLL_INTERVAL / 1000;
      if (verbose) {
        console.log(chalk.gray(`   Retry in ${retryAfter} seconds...`));
      }

      await sleep(retryAfter * 1000);

      try {
        const config = await configService.getValidProjectConfig();
        currentResponse = await requestClone(config.projectId);
        pollAttempts++;
      } catch (error: any) {
        console.error(chalk.yellow(`⚠️  Failed to check status: ${error.message}`));
        pollAttempts++;
        await sleep(RETRY_DELAY_MS);
      }
    }

    if (pollAttempts >= MAX_POLL_ATTEMPTS) {
      console.warn(chalk.yellow('⚠️  Polling timeout reached. Try again.'));
    }

    return currentResponse;
  },

  /**
   * Download all completed files from the response
   * @param response Clone response with file URLs
   * @param verbose Whether to show verbose output
   * @param force Whether to overwrite existing files
   * @returns Result with download statistics
   */
  async downloadFiles(response: ParsedCloneResponse, verbose = false, force = false): Promise<CloneResult> {
    const files = Object.entries(response.files);
    const totalFiles = files.length;
    let downloadedFiles = 0;
    const failedFiles: string[] = [];

    if (verbose) {
      console.log(chalk.blue(`Starting download of ${totalFiles} files...`));
    }

    const downloadPromises = files.map(async ([filePath, fileStatus]) => {
      if (fileStatus.status === 'completed') {
        const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
        if (fileExists && !force) {
          console.log(chalk.gray(`File already exists, skipping: ${filePath} (${fileStatus.language})`));
          return;
        }

        if (fileStatus.url) {
          const success = await downloadFileWithRetry(filePath, fileStatus, 3, verbose);
          if (success) {
            downloadedFiles++;
            if (fileExists && force && verbose) {
              console.log(chalk.blue(`  Overwritten existing file: ${filePath} (${fileStatus.language})`));
            }
          } else {
            failedFiles.push(filePath);
          }
        } else {
          if (verbose) {
            console.log(chalk.yellow(`⚠️  No URL available for completed file: ${filePath} (${fileStatus.language})`));
          }
          failedFiles.push(filePath);
        }
      } else if (fileStatus.status === 'failed') {
        if (verbose) {
          console.log(chalk.red(`❌ File generation failed: ${filePath} (${fileStatus.language})`));
        }
        failedFiles.push(filePath);
      } else if (fileStatus.status === 'generating') {
        if (verbose) {
          console.log(chalk.yellow(`⏳ File still generating: ${filePath} (${fileStatus.language})`));
        }
        failedFiles.push(filePath);
      }
    });

    await Promise.all(downloadPromises);

    if (downloadedFiles > 0 && verbose) {
      console.log(chalk.green(`✓ Downloaded ${downloadedFiles} files`));
    }

    if (failedFiles.length > 0) {
      console.log(chalk.yellow(`⚠️  ${failedFiles.length} files failed to download`));
      if (verbose) {
        for (const filePath of failedFiles) {
          console.log(chalk.gray(`   - ${filePath}`));
        }
      }
    }

    return {
      totalFiles,
      downloadedFiles,
      failedFiles
    };
  }
};