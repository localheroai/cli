import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

const defaultDeps = {
  fs,
  path,
  exec: execFileAsync,
};

export const gitService = {
  deps: { ...defaultDeps },

  setDependencies(customDeps = {}) {
    this.deps = { ...defaultDeps, ...customDeps };
    return this;
  },

  async updateGitignore(basePath) {
    const { fs, path } = this.deps;
    const gitignorePath = path.join(basePath, '.gitignore');
    let content = '';

    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch (error) {
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
    } catch (error) {
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

  async getCurrentBranch() {
    try {
      const { exec } = this.deps;
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  }
};

export async function updateGitignore(basePath) {
  return gitService.updateGitignore(basePath);
}

export async function getCurrentBranch() {
  return gitService.getCurrentBranch();
}