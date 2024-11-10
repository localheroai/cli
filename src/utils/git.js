import { promises as fs } from 'fs';
import path from 'path';

export async function updateGitignore(basePath) {
    const gitignorePath = path.join(basePath, '.gitignore');
    try {
        const content = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
        if (!content.includes('.localhero_key')) {
            await fs.appendFile(gitignorePath, '\n.localhero_key\n');
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
} 