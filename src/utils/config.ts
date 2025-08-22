import { promises as fs } from 'fs';
import path from 'path';
import { ProjectConfig, AuthConfig } from '../types/index.js';

/**
 * Dependencies for the config service
 */
interface ConfigDependencies {
  fs: typeof fs;
  path: typeof path;
  process: typeof process;
  cwd: () => string;
  [key: string]: unknown;
}

export interface ConfigService {
  deps: ConfigDependencies;
  setDependencies(customDeps?: Partial<ConfigDependencies>): ConfigService;
  configFilePath(basePath?: string): string;
  getAuthConfig(basePath?: string): Promise<AuthConfig | null>;
  saveAuthConfig(config: AuthConfig, basePath?: string): Promise<void>;
  getProjectConfig(basePath?: string): Promise<ProjectConfig | null>;
  saveProjectConfig(config: Partial<ProjectConfig>, basePath?: string): Promise<void>;
  validateProjectConfig(config: ProjectConfig): Promise<boolean>;
  getValidProjectConfig(basePath?: string): Promise<ProjectConfig>;
  updateLastSyncedAt(basePath?: string): Promise<ProjectConfig>;
}

const AUTH_CONFIG_FILE = '.localhero_key';
const PROJECT_CONFIG_FILE = 'localhero.json';
const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  schemaVersion: '1.0',
  projectId: '',
  sourceLocale: 'en',
  outputLocales: [],
  translationFiles: {
    paths: [],
    ignore: []
  },
  lastSyncedAt: null
};

const defaultDeps: ConfigDependencies = {
  fs,
  path,
  process,
  cwd: process.cwd
};

export const configService: ConfigService = {
  deps: { ...defaultDeps },

  /**
   * Set custom dependencies for testing
   */
  setDependencies(customDeps: Partial<ConfigDependencies> = {}): ConfigService {
    this.deps = { ...defaultDeps, ...customDeps };
    return this;
  },

  /**
   * Get the path to the config file
   */
  configFilePath(basePath?: string): string {
    const { path } = this.deps;
    const baseDir = basePath || this.deps.cwd();
    return path.join(baseDir, PROJECT_CONFIG_FILE);
  },

  /**
   * Get the authentication config
   */
  async getAuthConfig(basePath?: string): Promise<AuthConfig | null> {
    const { fs, path } = this.deps;
    const baseDir = basePath || this.deps.cwd();
    try {
      const configPath = path.join(baseDir, AUTH_CONFIG_FILE);
      const content = await fs.readFile(configPath, 'utf8');
      return JSON.parse(content) as AuthConfig;
    } catch {
      return null;
    }
  },

  /**
   * Save the authentication config
   */
  async saveAuthConfig(config: AuthConfig, basePath?: string): Promise<void> {
    const { fs, path } = this.deps;
    const baseDir = basePath || this.deps.cwd();
    const configPath = path.join(baseDir, AUTH_CONFIG_FILE);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
      mode: 0o600
    });
  },

  /**
   * Get the project config
   */
  async getProjectConfig(basePath?: string): Promise<ProjectConfig | null> {
    const { fs } = this.deps;
    try {
      const configPath = this.configFilePath(basePath);
      const content = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(content) as ProjectConfig;

      return config;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  },

  /**
   * Save the project config
   */
  async saveProjectConfig(config: Partial<ProjectConfig>, basePath?: string): Promise<void> {
    const { fs } = this.deps;
    const configPath = this.configFilePath(basePath);
    const configWithSchema = {
      ...DEFAULT_PROJECT_CONFIG,
      ...config,
      schemaVersion: DEFAULT_PROJECT_CONFIG.schemaVersion
    };
    await fs.writeFile(configPath, JSON.stringify(configWithSchema, null, 2));
  },

  /**
   * Validate the project config
   */
  async validateProjectConfig(config: ProjectConfig): Promise<boolean> {
    const required = ['projectId', 'sourceLocale', 'outputLocales', 'translationFiles'];
    const missing = required.filter(key => !(key in config));

    if (missing.length) {
      throw new Error(`Missing required config: ${missing.join(', ')}. Run 'npx @localheroai/cli init' to set up your project.`);
    }

    if (!Array.isArray(config.outputLocales) || config.outputLocales.length === 0) {
      throw new Error('outputLocales must be an array with at least one locale');
    }

    if (!config.translationFiles.paths || !Array.isArray(config.translationFiles.paths)) {
      throw new Error('translationFiles.paths must be an array of paths');
    }

    return true;
  },

  /**
   * Get the project config and validate it
   */
  async getValidProjectConfig(basePath?: string): Promise<ProjectConfig> {
    const config = await this.getProjectConfig(basePath);
    if (!config) {
      throw new Error('No project config found. Run `npx @localheroai/cli init` first');
    }
    await this.validateProjectConfig(config);
    return config;
  },

  /**
   * Update the lastSyncedAt field in the project config
   */
  async updateLastSyncedAt(basePath?: string): Promise<ProjectConfig> {
    const config = await this.getValidProjectConfig(basePath);
    config.lastSyncedAt = new Date().toISOString();
    await this.saveProjectConfig(config, basePath);
    return config;
  }
};