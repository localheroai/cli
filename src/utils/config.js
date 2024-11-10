import { promises as fs } from 'fs';
import { join } from 'path';

const CONFIG_FILE = '.localhero_key';
const PROJECT_CONFIG_FILE = 'localhero.json';

export async function getConfig(basePath = process.cwd()) {
    try {
        const configPath = join(basePath, CONFIG_FILE);
        const content = await fs.readFile(configPath, 'utf8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

export async function saveConfig(config, basePath = process.cwd()) {
    const configPath = join(basePath, CONFIG_FILE);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
        mode: 0o600 // User-only readable
    });
}

export async function getProjectConfig(basePath = process.cwd()) {
    try {
        const configPath = join(basePath, PROJECT_CONFIG_FILE);
        const content = await fs.readFile(configPath, 'utf8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

export async function saveProjectConfig(config, basePath = process.cwd()) {
    const configPath = join(basePath, PROJECT_CONFIG_FILE);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
} 