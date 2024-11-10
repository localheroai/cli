import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_CONFIG = {
    schemaVersion: '1.0',
    projectId: '',
    sourceLocale: 'en',
    outputLocales: [],
    translationFiles: {
        paths: [],
        ignore: []
    }
};

export const defaultConfigService = {
    async getProjectConfig(basePath) {
        try {
            const configPath = path.join(basePath, 'localhero.json');
            const content = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(content);

            // Validate schema version
            if (config.schemaVersion !== DEFAULT_CONFIG.schemaVersion) {
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

    async saveProjectConfig(config, basePath) {
        const configPath = path.join(basePath, 'localhero.json');
        const configWithSchema = {
            ...DEFAULT_CONFIG,
            ...config,
            schemaVersion: DEFAULT_CONFIG.schemaVersion
        };
        await fs.writeFile(configPath, JSON.stringify(configWithSchema, null, 2));
    }
}; 