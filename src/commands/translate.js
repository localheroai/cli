import chalk from 'chalk';
import { configService } from '../utils/config.js';
import { findTranslationFiles } from '../utils/files.js';
import { createTranslationJob, checkJobStatus } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater.js';
import path from 'path';
import { checkAuth } from '../utils/auth.js';
import { autoCommitChanges } from '../utils/github.js';

const DEFAULT_LOCALE_REGEX = '.*?([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$';
const MAX_RETRY_ATTEMPTS = 3;
const BATCH_SIZE = 100;

function validateConfig(config) {
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
}

function findMissingTranslations(sourceKeys, targetKeys) {
    const missing = {};

    for (const [key, translationEntry] of Object.entries(sourceKeys)) {
        if (!targetKeys[key]) {
            // Ignore keys that are marked as WIP
            if (typeof translationEntry.value === 'string' &&
                (translationEntry.value.startsWith('[WIP]') || translationEntry.value.endsWith('[WIP]'))) {
                console.info(chalk.gray("Ignoring key:", key));
            } else {
                missing[key] = translationEntry.value;
            }
        }
    }

    return missing;
}

async function retryWithBackoff(operation, attempt = 1) {
    try {
        return await operation();
    } catch (error) {
        if (error.code === 'invalid_api_key') {
            console.error(chalk.red('\n❌ ' + error.message));
            process.exit(1);
        }

        if (attempt >= MAX_RETRY_ATTEMPTS) throw error;

        const backoffTime = Math.min(1000 * Math.pow(2, attempt), 30000);
        const jitter = Math.random() * 1000;
        const waitTime = backoffTime + jitter;

        console.log(chalk.yellow(`⚠️  API error, retrying in ${Math.round(waitTime / 1000)}s (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`));
        console.log(error);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        return retryWithBackoff(operation, attempt + 1);
    }
}

function batchKeysWithMissing(sourceFiles, missingByLocale, batchSize = BATCH_SIZE) {
    const batches = [];
    const sourceFileEntries = new Map();

    for (const [locale, localeData] of Object.entries(missingByLocale)) {
        const sourceFile = sourceFiles.find(f => f.path === localeData.path);
        if (!sourceFile) continue;

        if (!sourceFileEntries.has(sourceFile.path)) {
            sourceFileEntries.set(sourceFile.path, {
                path: path.relative(process.cwd(), sourceFile.path),
                keys: {},
                locales: new Set()
            });
        }

        const entry = sourceFileEntries.get(sourceFile.path);
        entry.keys = { ...entry.keys, ...localeData.keys };
        entry.locales.add(locale);
    }

    for (const entry of sourceFileEntries.values()) {
        const keys = entry.keys;
        const keyEntries = Object.entries(keys);
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

export async function translate(options = {}) {
    const { verbose = false, commit = false } = options;
    const log = verbose ? console.log : () => { };

    try {
        const config = await configService.getValidProjectConfig();
        const isAuthenticated = await checkAuth();

        if (!isAuthenticated) {
            throw new Error('No API key found. Run `npx localhero login` or set LOCALHERO_API_KEY');
        }

        console.log(chalk.blue('ℹ️  Loading configuration from localhero.json'));

        const { translationFiles } = config;
        const fileLocaleRegex = DEFAULT_LOCALE_REGEX;
        let allFiles = [];

        for (const translationPath of translationFiles.paths) {
            const filesInPath = await findTranslationFiles(translationPath, fileLocaleRegex);
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
                    console.log(chalk.blue(`  ${targetLocale} (${path.basename(sourceFile.path)}): ${missingCount} missing keys`));
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
        const processedKeys = new Set();
        let hasShownUpdateMessage = false;

        for (const [batchIndex, batch] of batches.entries()) {
            log(chalk.blue(`\nProcessing batch ${batchIndex + 1}/${batches.length}...`));

            try {
                const { jobs } = await retryWithBackoff(() =>
                    createTranslationJob({
                        sourceFiles: batch.files,
                        targetLocales: batch.locales,
                        projectId: config.projectId
                    })
                );
                const jobStatuses = new Map();
                let allCompleted = false;

                while (!allCompleted) {
                    allCompleted = true;
                    let totalProgress = 0;

                    for (const job of jobs) {
                        const status = await retryWithBackoff(() => checkJobStatus(job.id, true));
                        jobStatuses.set(job.id, status);

                        if (status.status === 'processing') {
                            allCompleted = false;
                        }
                        totalProgress += status.progress.percentage;
                    }

                    const averageProgress = Math.round(totalProgress / jobs.length);
                    const bar = '='.repeat(averageProgress / 2) + ' '.repeat(50 - averageProgress / 2);

                    process.stdout.write(`\r⧗ Translating... [${bar}] ${averageProgress}%`);

                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                for (const job of jobs) {
                    const status = jobStatuses.get(job.id);
                    if (status.status === 'completed' && status.translations) {
                        if (!hasShownUpdateMessage) {
                            console.log(chalk.blue('\nℹ️  Updating translation files...'));
                            hasShownUpdateMessage = true;
                        }

                        const translations = status.translations.translations;
                        const targetLocale = status.language.code;
                        const uniqueKey = `${targetLocale}:${Object.keys(translations).sort().join(',')}`;

                        if (processedKeys.has(uniqueKey)) {
                            continue;
                        }
                        processedKeys.add(uniqueKey);

                        const targetFile = targetFiles.find(f => f.locale === targetLocale)?.path ||
                            path.join(config.translationPath, `${targetLocale}.yml`);

                        try {
                            const updatedKeys = await updateTranslationFile(
                                targetFile,
                                translations,
                                targetLocale
                            );

                            updatedFiles.add(targetFile);
                            totalKeysProcessed += updatedKeys.length;

                            if (verbose) {
                                console.log(chalk.blue(`  Updated ${targetFile}`));
                                updatedKeys.forEach(key => console.log(chalk.gray(`  - Added: ${key}`)));
                            } else {
                                console.log(chalk.blue(`  Updated ${path.basename(targetFile)}`));
                            }
                        } catch (error) {
                            console.error(chalk.yellow(`⚠️  Failed to update ${targetFile}: ${error.message}`));
                            totalErrors++;
                        }
                    }
                }
            } catch (error) {
                totalErrors++;
                console.error(chalk.red(`❌ Batch ${batchIndex + 1} failed: ${error.message}`));
                console.log(error);

            }
        }

        if (totalErrors > 0) {
            console.error(chalk.red(`\n❌ Translation completed with ${totalErrors} failed batches`));
            process.exit(1);
        }

        const updatedLocales = new Set(Object.keys(missingByLocale));
        console.log(chalk.green('\n✓ Translations complete!') + ` Updated ${totalKeysProcessed} keys in ${updatedLocales.size} languages`);

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