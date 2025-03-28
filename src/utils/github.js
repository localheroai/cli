import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const defaultDependencies = {
  exec: (cmd, options) => execSync(cmd, options),
  fs,
  path,
  env: process.env
};

export const githubService = {
  deps: { ...defaultDependencies },

  // For testing - reset or inject custom dependencies
  setDependencies(customDeps = {}) {
    this.deps = { ...defaultDependencies, ...customDeps };
    return this;
  },

  isGitHubAction() {
    return this.deps.env.GITHUB_ACTIONS === 'true';
  },

  async createGitHubActionFile(basePath, translationPaths) {
    const { fs, path } = this.deps;
    const workflowDir = path.join(basePath, '.github', 'workflows');
    const workflowFile = path.join(workflowDir, 'localhero-translate.yml');

    await fs.mkdir(workflowDir, { recursive: true });

    const actionContent = `name: Localhero.ai - I18n translation

on:
  pull_request:
    paths:
      ${translationPaths.map(p => {
      // Check if path already contains a file pattern (*, ?, or {})
      const hasPattern = /[*?{}]/.test(p);
      // If it has a pattern, use it as is; otherwise, append /**
      const formattedPath = hasPattern ? p : `${p}${p.endsWith('/') ? '' : '/'}**`;
      return `- "${formattedPath}"`;
    }).join('\n      ')}

jobs:
  translate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
    - name: Checkout code
      uses: actions/checkout@v4
      with:
        ref: \${{ github.head_ref }}
        fetch-depth: 0

    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 22

    - name: Run LocalHero CLI
      env:
        LOCALHERO_API_KEY: \${{ secrets.LOCALHERO_API_KEY }}
        GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      run: npx -y @localheroai/cli translate`;

    await fs.writeFile(workflowFile, actionContent);
    return workflowFile;
  },

  autoCommitChanges(filesPath) {
    const { exec, env } = this.deps;

    if (!this.isGitHubAction()) return;

    console.log("Running in GitHub Actions. Committing changes...");
    try {
      exec('git config --global user.name "LocalHero Bot"', { stdio: "inherit" });
      exec('git config --global user.email "hi@localhero.ai"', { stdio: "inherit" });

      const branchName = env.GITHUB_HEAD_REF;
      if (!branchName) {
        throw new Error('Could not determine branch name from GITHUB_HEAD_REF');
      }

      exec(`git add ${filesPath}`, { stdio: "inherit" });

      const status = exec('git status --porcelain').toString();
      if (!status) {
        console.log("No changes to commit.");
        return;
      }

      exec('git commit -m "Update translations"', { stdio: "inherit" });

      const token = env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN is not set');
      }

      const repository = env.GITHUB_REPOSITORY;
      if (!repository) {
        throw new Error('GITHUB_REPOSITORY is not set');
      }

      const remoteUrl = `https://x-access-token:${token}@github.com/${repository}.git`;

      exec(`git remote set-url origin ${remoteUrl}`, { stdio: "inherit" });
      exec(`git push origin HEAD:${branchName}`, { stdio: "inherit" });
      console.log("Changes committed and pushed successfully.");
    } catch (error) {
      console.error("Auto-commit failed:", error.message);
      throw error;
    }
  }
};

// Only export the functions needed externally
export function createGitHubActionFile(basePath, translationPaths) {
  return githubService.createGitHubActionFile(basePath, translationPaths);
}

export function autoCommitChanges(filesPath) {
  return githubService.autoCommitChanges(filesPath);
}