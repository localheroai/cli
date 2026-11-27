import { jest } from '@jest/globals';
import { translate, type TranslationOptions } from '../../src/commands/translate.js';
import { findTranslationFiles } from '../../src/utils/files.js';
import { createTranslationJob, checkJobStatus } from '../../src/api/translations.js';
import { fetchSettings } from '../../src/api/settings.js';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';
import {
  findMissingTranslations,
  batchKeysWithMissing,
  findMissingTranslationsByLocale
} from '../../src/utils/translation-utils.js';
import type { ProjectConfig } from '../../src/types/index.js';

export interface TranslateRun {
  output: () => string;
  autoCommitChanges: jest.Mock<any>;
  execSync: jest.Mock<any>;
  run: (options?: TranslationOptions) => Promise<void>;
}

/**
 * Runs the translate command with its real file, git and API modules. Only the
 * configuration, the API key check and the commit are stand-ins.
 */
export function translateRunner(config: Partial<ProjectConfig>, commitResult = 'no-changes'): TranslateRun {
  const lines: string[] = [];
  const record = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  const autoCommitChanges = jest.fn<any>(async () => commitResult);
  const execSync = jest.fn<any>();

  const deps: any = {
    console: { log: record, error: record, warn: record },
    configUtils: {
      getProjectConfig: async () => structuredClone({ schemaVersion: '1.0', lastSyncedAt: null, ...config }),
      updateLastSyncedAt: async () => undefined
    },
    authUtils: { checkAuth: async () => true },
    settingsUtils: { fetchSettings },
    fileUtils: { findTranslationFiles },
    translationUtils: {
      createTranslationJob,
      checkJobStatus,
      updateTranslationFile,
      findMissingTranslations,
      batchKeysWithMissing,
      findMissingTranslationsByLocale
    },
    gitUtils: { autoCommitChanges },
    execUtils: { execSync }
  };

  return {
    output: () => lines.join('\n'),
    autoCommitChanges,
    execSync,
    run: (options = {}) => translate(options, deps)
  };
}
