import chalk from 'chalk';
import { configService } from '../utils/config.js';
import { findTranslationFiles } from '../utils/files.js';
import { createTranslationJob, checkJobStatus } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater.js';
import { syncService } from '../utils/sync-service.js';
import { checkAuth } from '../utils/auth.js';
import { autoCommitChanges } from '../utils/github.js';

const DEFAULT_LOCALE_REGEX = '.*?([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$';
const BATCH_SIZE = 100;

const defaultDeps = {
    console,
    configUtils: configService,
    authUtils: { checkAuth },
    fileUtils: { findTranslationFiles },
    translationUtils: {
        createTranslationJob,
        checkJobStatus,
        updateTranslationFile
    },
    syncUtils: syncService
};

function findMissingTranslations(sourceKeys, targetKeys) {
    const missing = {};
    for (const [key, translation] of Object.entries(sourceKeys)) {
        if (!targetKeys[key] && !translation.value.startsWith('[WIP]') && !translation.value.endsWith('[WIP]')) {
            missing[key] = translation;
        }
    }
    return missing;
}

function batchKeysWithMissing(sourceFiles, missingByLocale, batchSize = BATCH_SIZE) {
    const batches = [];
    const sourceFileEntries = new Map();

    for (const [locale, localeData] of Object.entries(missingByLocale)) {
        const sourceFile = sourceFiles.find(f => f.path === localeData.path);
        if (!sourceFile) continue;

        if (!sourceFileEntries.has(sourceFile.path)) {
            sourceFileEntries.set(sourceFile.path, {
                path: sourceFile.path,
                keys: {},
                locales: new Set()
            });
        }

        const entry = sourceFileEntries.get(sourceFile.path);
        entry.keys = { ...entry.keys, ...localeData.keys };
        entry.locales.add(locale);
    }

    for (const entry of sourceFileEntries.values()) {
        const keyEntries = Object.entries(entry.keys);
        for (let i = 0; i < keyEntries.length; i += batchSize) {
            const batchKeys = Object.fromEntries(keyEntries.slice(i, i + batchSize));
            batches.push({
                files: [{
                    path: entry.path,
                    content: Buffer.from(JSON.stringify({ keys: batchKeys })).toString('base64')
                }],
                locales: Array.from(entry.locales)
            });
        }
    }

    return batches;
}

export async function translate(options = {}, deps = defaultDeps) {
    const { verbose = false, commit = false } = options;
    const {
        console,
        configUtils,
        authUtils,
        fileUtils,
        translationUtils,
        syncUtils
    } = deps;

    const log = verbose ? console.log : () => { };

    try {
        const isAuthenticated = await authUtils.checkAuth();
        if (!isAuthenticated) {
            console.error(chalk.red('❌ Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key'));
            process.exit(1);
        }

        const config = await configUtils.getValidProjectConfig();

        // First, check and apply any updates we don't have locally
        const { hasUpdates, updates } = await syncUtils.checkForUpdates({ verbose });
        if (hasUpdates) {
            await syncUtils.applyUpdates(updates, { verbose });
        }

        console.log(chalk.blue('ℹ️  Loading configuration from localhero.json'));

        const { translationFiles } = config;
        let allFiles = [];

        for (const translationPath of translationFiles.paths) {
            const filesInPath = await fileUtils.findTranslationFiles(translationPath, DEFAULT_LOCALE_REGEX);
            allFiles = allFiles.concat(filesInPath);
        }

        if (!allFiles.length) {
            console.error(chalk.red('❌ No translation files found'));
            process.exit(1);
        }

        const sourceFiles = allFiles.filter(f => f.locale === config.sourceLocale);
        const targetFiles = allFiles.filter(f => config.outputLocales.includes(f.locale));

        if (!sourceFiles.length) {
            console.error(chalk.red(`❌ No source files found for locale ${config.sourceLocale}`));
            process.exit(1);
        }

        log(chalk.blue(`✓ Found ${allFiles.length} translation files`));
        log(chalk.blue(`ℹ️  Analyzing target translations...`));

        const missingByLocale = {};
        for (const sourceFile of sourceFiles) {
            const sourceContent = JSON.parse(Buffer.from(sourceFile.content, 'base64').toString());

            for (const targetLocale of config.outputLocales) {
                const targetFile = targetFiles.find(f => f.locale === targetLocale);
                const targetContent = targetFile ?
                    JSON.parse(Buffer.from(targetFile.content, 'base64').toString()) :
                    { keys: {} };

                const missing = findMissingTranslations(sourceContent.keys, targetContent.keys);
                const missingCount = Object.keys(missing).length;

                if (missingCount > 0) {
                    if (!missingByLocale[targetLocale]) {
                        missingByLocale[targetLocale] = {
                            keys: {},
                            path: sourceFile.path
                        };
                    }
                    missingByLocale[targetLocale].keys = {
                        ...missingByLocale[targetLocale].keys,
                        ...missing
                    };
                    console.log(chalk.blue(`  ${targetLocale}: ${missingCount} missing keys`));
                }
            }
        }

        if (Object.keys(missingByLocale).length === 0) {
            console.log(chalk.green('✓ All translations are up to date!'));
            return;
        }

        const updatedFiles = new Set();
        const batches = batchKeysWithMissing(sourceFiles, missingByLocale);
        let totalKeysProcessed = 0;
        let totalErrors = 0;

        for (const [batchIndex, batch] of batches.entries()) {
            log(chalk.blue(`\nProcessing batch ${batchIndex + 1}/${batches.length}...`));

            try {
                const { jobs } = await translationUtils.createTranslationJob({
                    projectId: config.projectId,
                    sourceFiles: batch.files,
                    targetLocales: batch.locales
                });

                for (const job of jobs) {
                    let status;
                    let retries = 0;
                    const MAX_WAIT_MINUTES = 10;
                    const startTime = Date.now();

                    do {
                        status = await translationUtils.checkJobStatus(job.id, true);

                        if (status.status === 'failed') {
                            throw new Error(`Translation job failed: ${status.error_details || 'Unknown error'}`);
                        }

                        if (status.status === 'pending' || status.status === 'processing') {
                            const elapsed = Math.floor((Date.now() - startTime) / 1000);
                            if (elapsed > MAX_WAIT_MINUTES * 60) {
                                throw new Error(`Translation timed out after ${MAX_WAIT_MINUTES} minutes`);
                            }

                            const waitSeconds = 2 ** retries;
                            log(chalk.blue(`  Job ${job.id} is ${status.status}, checking again in ${waitSeconds}s...`));
                            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                            retries = Math.min(retries + 1, 5);
                        }
                    } while (status.status === 'pending' || status.status === 'processing');

                    if (status.status === 'completed' && status.translations) {
                        const translations = status.translations.translations;
                        const targetLocale = status.language.code;
                        const targetFile = targetFiles.find(f => f.locale === targetLocale)?.path;

                        if (targetFile) {
                            const updatedKeys = await translationUtils.updateTranslationFile(
                                targetFile,
                                translations,
                                targetLocale
                            );

                            updatedFiles.add(targetFile);
                            totalKeysProcessed += updatedKeys.length;

                            if (verbose) {
                                console.log(chalk.blue(`  Updated ${targetFile}`));
                                updatedKeys.forEach(key => console.log(chalk.gray(`  - Added: ${key}`)));
                            }
                        }
                    }
                }
            } catch (error) {
                totalErrors++;
                console.error(chalk.red(`❌ ${error.message}`));
                process.exit(1);
            }
        }

        if (totalErrors > 0) {
            console.error(chalk.red(`\n❌ Translation completed with ${totalErrors} failed batches`));
            process.exit(1);
        }

        const updatedLocales = new Set(Object.keys(missingByLocale));
        console.log(chalk.green('\n✓ Translations complete!') + ` Updated ${totalKeysProcessed} keys in ${updatedLocales.size} languages`);

        await configUtils.updateLastSyncedAt();
        updatedFiles.add(configUtils.configFilePath());

        if (commit || process.env.GITHUB_ACTIONS === 'true') {
            const translationPaths = Array.from(updatedFiles).join(' ');
            if (translationPaths) {
                autoCommitChanges(translationPaths);
            }
        }
    } catch (error) {
        console.error(chalk.red(`❌ ${error.message}`));
        process.exit(1);
    }
} 