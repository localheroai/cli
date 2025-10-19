import { syncService as defaultSyncService } from '../utils/sync-service.js';
import { configService } from '../utils/config.js';
import { findTranslationFiles } from '../utils/files.js';
import { isGitAvailable, getChangedKeysForProject } from '../utils/git-changes.js';
import { PLURAL_SUFFIX_REGEX, extractBaseKeys } from '../utils/po-utils.js';
import chalk from 'chalk';
import type { Updates } from '../utils/sync-service.js';
import type {
  TranslationFile,
  ProjectConfig,
  TranslationFilesResult,
  TranslationFileOptions
} from '../types/index.js';

interface PullDependencies {
  syncService: {
    checkForUpdates: (verbose?: boolean) => Promise<{
      hasUpdates: boolean;
      updates?: Updates;
    }>;
    applyUpdates: (
      updates: Updates,
      verbose?: boolean
    ) => Promise<{
      totalUpdates: number;
      totalDeleted: number;
    }>;
  };
  gitUtils?: {
    isGitAvailable: () => boolean;
    getChangedKeysForProject: (
      sourceFiles: TranslationFile[],
      config: ProjectConfig,
      verbose: boolean
    ) => Set<string> | null;
  };
  configUtils?: {
    getValidProjectConfig: () => Promise<ProjectConfig>;
  };
  fileUtils?: {
    findTranslationFiles: (
      config: ProjectConfig,
      options?: TranslationFileOptions
    ) => Promise<TranslationFile[] | TranslationFilesResult>;
  };
}

interface PullResult {
  totalUpdates: number;
  totalDeleted: number;
}

/**
 * Filter updates to only include translations for changed keys
 * Includes both exact key matches and related plural forms
 */
function filterUpdatesByKeys(updates: Updates, changedKeys: Set<string>): Updates {
  // Extract base keys from plural forms in changedKeys (only relevant for .po files)
  const baseChangedKeys = extractBaseKeys(changedKeys);

  return {
    updates: {
      files: updates.updates.files
        .map(file => ({
          ...file,
          languages: file.languages
            .map(lang => ({
              ...lang,
              translations: lang.translations.filter(t => {
                // Include if key changed
                if (changedKeys.has(t.key)) {
                  return true;
                }
                // Include if base key changed (for plurals)
                const baseKey = t.key.replace(PLURAL_SUFFIX_REGEX, '');
                return baseKey !== t.key && baseChangedKeys.has(baseKey);
              })
            }))
            .filter(lang => lang.translations.length > 0)
        }))
        .filter(file => file.languages.length > 0),
      deleted_keys: updates.updates.deleted_keys.filter(key =>
        changedKeys.has(key.name)
      )
    }
  };
}

/**
 * Pull translations from LocalHero.ai and apply them to local files
 */
export async function pull(
  { verbose = false, changedOnly = false }: { verbose?: boolean; changedOnly?: boolean } = {},
  deps: PullDependencies = {
    syncService: defaultSyncService,
    gitUtils: { isGitAvailable, getChangedKeysForProject },
    configUtils: configService,
    fileUtils: { findTranslationFiles }
  }
): Promise<PullResult | void> {
  const {
    syncService,
    gitUtils = { isGitAvailable, getChangedKeysForProject },
    configUtils = configService,
    fileUtils = { findTranslationFiles }
  } = deps;

  // Validate git availability for --changed-only
  if (changedOnly && !gitUtils.isGitAvailable()) {
    const error = new Error('Git is required for the --changed-only flag but is not available.') as any;
    error.cliErrorMessage = 'Git is required for the --changed-only flag but is not available.\n\nPlease ensure you are in a git repository.';
    throw error;
  }

  let { hasUpdates, updates } = await syncService.checkForUpdates(verbose);

  if (!hasUpdates || !updates) {
    console.log(chalk.green('✓ All translations are up to date'));
    return;
  }

  if (changedOnly) {
    const config = await configUtils.getValidProjectConfig();
    const filesResult = await fileUtils.findTranslationFiles(config, {
      parseContent: false,
      includeContent: false,
      extractKeys: false,
      returnFullResult: true,
      verbose
    });

    if (!('sourceFiles' in filesResult)) {
      throw new Error('Expected TranslationFilesResult but got TranslationFile[]');
    }

    const sourceFiles = filesResult.sourceFiles;
    const changedKeys = gitUtils.getChangedKeysForProject(sourceFiles, config, verbose);

    if (changedKeys === null) {
      const baseBranch = config.translationFiles?.baseBranch || process.env.GITHUB_BASE_REF || 'main';
      const error = new Error('Could not determine changed keys.') as any;
      error.cliErrorMessage = `Could not determine changed keys.\n\nThe base branch '${baseBranch}' may not exist locally, or the changeset is too large.\nRun with --verbose for more details, or run without --changed-only to pull all updates.`;
      throw error;
    }

    if (changedKeys.size === 0) {
      console.log(chalk.green('✓ No changed keys to pull'));
      return;
    }

    updates = filterUpdatesByKeys(updates, changedKeys);
  }

  const result = await syncService.applyUpdates(updates, verbose);

  const { totalUpdates = 0, totalDeleted = 0 } = result;

  if (!verbose) {
    if (totalUpdates > 0) {
      console.log(chalk.green(`✓ Updated ${totalUpdates} translations`));
    }

    if (totalDeleted > 0) {
      console.log(chalk.green(`✓ Deleted ${totalDeleted} keys`));
    }
  }

  return result;
}
