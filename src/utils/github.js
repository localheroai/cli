import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export function isGitHubAction() {
  return process.env.GITHUB_ACTIONS === 'true';
}

export async function createGitHubActionFile(basePath, translationPaths) {
  const workflowDir = path.join(basePath, '.github', 'workflows');
  const workflowFile = path.join(workflowDir, 'localhero-translate.yml');

  await fs.mkdir(workflowDir, { recursive: true });

  const actionContent = `name: Localhero.ai - I18n translation

on:
  pull_request:
    paths:
      ${translationPaths.map(p => `- "${p}"`).join('\n      ')}

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
        node-version: 18

    - name: Run LocalHero CLI
      env:
        LOCALHERO_API_KEY: \${{ secrets.LOCALHERO_API_KEY }}
        GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      run: npx @localheroai/cli translate`;

  await fs.writeFile(workflowFile, actionContent);
  return workflowFile;
}

export function autoCommitChanges(filesPath) {
  if (!isGitHubAction()) return;

  console.log("Running in GitHub Actions. Committing changes...");
  try {
    execSync('git config --global user.name "LocalHero Bot"', { stdio: "inherit" });
    execSync('git config --global user.email "hi@localhero.ai"', { stdio: "inherit" });

    const branchName = process.env.GITHUB_HEAD_REF;
    if (!branchName) {
      throw new Error('Could not determine branch name from GITHUB_HEAD_REF');
    }

    execSync(`git add ${filesPath}`, { stdio: "inherit" });

    const status = execSync('git status --porcelain').toString();
    if (!status) {
      console.log("No changes to commit.");
      return;
    }

    execSync('git commit -m "Update translations"', { stdio: "inherit" });

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set');
    }

    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY is not set');
    }

    const remoteUrl = `https://x-access-token:${token}@github.com/${repository}.git`;

    execSync(`git remote set-url origin ${remoteUrl}`, { stdio: "inherit" });
    execSync(`git push origin HEAD:${branchName}`, { stdio: "inherit" });
    console.log("Changes committed and pushed successfully.");
  } catch (error) {
    console.error("Auto-commit failed:", error.message);
    throw error;
  }
} 