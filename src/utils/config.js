import { promises as fs } from 'fs';
import path from 'path';

const AUTH_CONFIG_FILE = '.localhero_key';
const PROJECT_CONFIG_FILE = 'localhero.json';

const DEFAULT_PROJECT_CONFIG = {
    schemaVersion: '1.0',
    projectId: '',
    sourceLocale: 'en',
    outputLocales: [],
    translationFiles: {
        paths: [],
        ignore: []
    }
};

export const configService = {
    async getAuthConfig(basePath = process.cwd()) {
        try {
            const configPath = path.join(basePath, AUTH_CONFIG_FILE);
            const content = await fs.readFile(configPath, 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    },

    async saveAuthConfig(config, basePath = process.cwd()) {
        const configPath = path.join(basePath, AUTH_CONFIG_FILE);
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
            mode: 0o600 // User-only readable
        });
    },

    async getProjectConfig(basePath = process.cwd()) {
        try {
            const configPath = path.join(basePath, PROJECT_CONFIG_FILE);
            const content = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(content);

            if (config.schemaVersion !== DEFAULT_PROJECT_CONFIG.schemaVersion) {
                throw new Error(`Unsupported config schema version: ${config.schemaVersion}`);
            }

            return config;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    },

    async saveProjectConfig(config, basePath = process.cwd()) {
        const configPath = path.join(basePath, PROJECT_CONFIG_FILE);
        const configWithSchema = {
            ...DEFAULT_PROJECT_CONFIG,
            ...config,
            schemaVersion: DEFAULT_PROJECT_CONFIG.schemaVersion
        };
        await fs.writeFile(configPath, JSON.stringify(configWithSchema, null, 2));
    },

    async validateProjectConfig(config) {
        const required = ['projectId', 'sourceLocale', 'outputLocales', 'translationFiles'];
        const missing = required.filter(key => !config[key]);

        if (missing.length) {
            throw new Error(`Missing required config: ${missing.join(', ')}. Run 'npx localhero init' to set up your project.`);
        }

        if (!Array.isArray(config.outputLocales) || config.outputLocales.length === 0) {
            throw new Error('outputLocales must be an array with at least one locale');
        }

        if (config.outputLocales.length > 10) {
            throw new Error('Maximum 10 target languages allowed per request');
        }

        if (!config.translationFiles.paths || !Array.isArray(config.translationFiles.paths)) {
            throw new Error('translationFiles.paths must be an array of paths');
        }

        return true;
    },

    async getValidProjectConfig(basePath = process.cwd()) {
        const config = await this.getProjectConfig(basePath);
        if (!config) {
            throw new Error('No localhero.json found. Run `npx localhero init` first');
        }
        await this.validateProjectConfig(config);
        return config;
    }
}; 