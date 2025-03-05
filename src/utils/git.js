import { promises as fs } from 'fs';
import path from 'path';

export async function updateGitignore(basePath) {
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
}

export async function getCurrentBranch() {
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        return stdout.trim();
    } catch {
        return null;
    }
} 