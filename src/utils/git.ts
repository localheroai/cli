import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

/**
 * Dependencies for the git service
 */
interface GitDependencies {
  fs: typeof fs;
  path: typeof path;
  exec: typeof execFileAsync;
  [key: string]: unknown;
}

const execFileAsync = promisify(execFile);

const defaultDeps: GitDependencies = {
  fs,
  path,
  exec: execFileAsync,
};

export const gitService = {
  deps: { ...defaultDeps },

  /**
   * Set custom dependencies for testing
   */
  setDependencies(customDeps: Partial<GitDependencies> = {}): typeof gitService {
    this.deps = { ...defaultDeps, ...customDeps };
    return this;
  },

  /**
   * Add .localhero_key to .gitignore file
   * @param basePath Base path to project
   * @returns Boolean indicating if the file was updated
   */
  async updateGitignore(basePath: string): Promise<boolean> {
    const { fs, path } = this.deps;
    const gitignorePath = path.join(basePath, '.gitignore');
    let content = '';

    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        return false;
      }
    }

    if (content.includes('.localhero_key')) {
      return false;
    }

    try {
      await fs.appendFile(gitignorePath, '\n.localhero_key\n');
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        try {
          await fs.writeFile(gitignorePath, '.localhero_key\n');
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  },

  /**
   * Get the current git branch name
   * @returns Current branch name or null if not in a git repository
   */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const { exec } = this.deps;
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  }
};

/**
 * Add .localhero_key to .gitignore file
 * @param basePath Base path to project
 * @returns Boolean indicating if the file was updated
 */
export async function updateGitignore(basePath: string): Promise<boolean> {
  return gitService.updateGitignore(basePath);
}

/**
 * Get the current git branch name
 * @returns Current branch name or null if not in a git repository
 */
export async function getCurrentBranch(): Promise<string | null> {
  return gitService.getCurrentBranch();
}