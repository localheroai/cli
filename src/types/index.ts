// Config Types
export interface AuthConfig {
  api_key: string;
  last_verified?: string;
}

// For translation file in config
export interface TranslationFileConfig {
  paths: string[];
  pattern?: string;
  ignore?: string[];
  localeRegex?: string;
}

// Translation file interface
export interface TranslationFile {
  path: string;
  format: string; // e.g., 'json', 'yml'
  locale: string; // e.g., 'en', 'fr'

  namespace?: string;
  content?: string;
  hasLanguageWrapper?: boolean;
  translations?: Record<string, string>;
  keys?: string[];
}

/**
 * Project configuration interface
 *
 * This is the single source of truth for project configuration
 */
export interface ProjectConfig {
  /** Schema version for config format compatibility */
  schemaVersion: string;

  /** Project identifier from LocalHero */
  projectId: string;

  /** Source locale code (e.g., 'en') */
  sourceLocale: string;

  /** Target locale codes (e.g., ['fr', 'de', 'es']) */
  outputLocales: string[];

  /** Translation files configuration */
  translationFiles: TranslationFileConfig;

  /** Last time translations were synced */
  lastSyncedAt: string | null;
}

// Simplified translation config
export interface TranslationConfig {
  sourceLocale: string;
  outputLocales: string[];
  translationFiles: TranslationFileConfig;
}

// API Response Types
export class ApiResponseError extends Error {
  cliErrorMessage: string;
  code: string;
  details: any | null;
  data: any;

  constructor(message: string, options?: {
    code?: string;
    details?: any;
    data?: any;
    cliErrorMessage?: string;
  }) {
    super(message);
    this.name = 'ApiResponseError';
    this.cliErrorMessage = options?.cliErrorMessage || message;
    this.code = options?.code || 'API_ERROR';
    this.details = options?.details || null;
    this.data = options?.data || null;
  }
}

export interface Project {
  id: string;
  name: string;
}

export interface Organization {
  name: string;
  projects: Project[];
}

// For translation file results
export interface TranslationFilesResult {
  allFiles: TranslationFile[];
  sourceFiles: TranslationFile[];
  targetFilesByLocale: Record<string, TranslationFile[]>;
}

// Translation Command Dependencies
export interface TranslationFileOptions {
  parseContent?: boolean;
  includeContent?: boolean;
  extractKeys?: boolean;
  basePath?: string;
  sourceLocale?: string;
  targetLocales?: string[];
  includeNamespace?: boolean;
  verbose?: boolean;
  returnFullResult?: boolean;
}