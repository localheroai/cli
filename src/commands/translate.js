import chalk from 'chalk';
import { configService } from '../utils/config.js';
import { findTranslationFiles, extractLocaleFromPath, isValidLocale, flattenTranslations, parseFile } from '../utils/files.js';
import { createTranslationJob, checkJobStatus } from '../api/translations.js';
import { updateTranslationFile } from '../utils/translation-updater.js';
import { syncService } from '../utils/sync-service.js';
import { checkAuth } from '../utils/auth.js';
import { autoCommitChanges } from '../utils/github.js';
import { findMissingTranslations, batchKeysWithMissing } from '../utils/translation-utils.js';
import path from 'path';
import { glob } from 'glob';
import fs from 'fs/promises';

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
        updateTranslationFile,
        findMissingTranslations,
        batchKeysWithMissing
    },
    syncUtils: syncService
};

export async function translate(options = {}, deps = defaultDeps) {
    const { verbose = false, commit = false } = options;
    const {
        console,
        configUtils,
        authUtils,
        translationUtils
    } = deps;

    try {
        const isAuthenticated = await authUtils.checkAuth();
        if (!isAuthenticated) {
            console.error(chalk.red('❌ Your API key is invalid or has been revoked. Please run `npx @localheroai/cli login` to update your API key'));
            process.exit(1);
        }

        console.log(chalk.blue('Loading configuration from localhero.json'));

        const rawConfig = await configUtils.getProjectConfig();

        if (!rawConfig) {
            console.error(chalk.red('❌ No configuration found. Please run `npx @localheroai/cli init` first'));
            process.exit(1);
        }

        const config = {
            ...rawConfig,
            translationFiles: rawConfig.translationFiles || {
                paths: [],
                pattern: '**/*.{json,yml,yaml}',
                ignore: []
            }
        };

        if (!Array.isArray(config.translationFiles.paths)) {
            config.translationFiles.paths = [config.translationFiles.paths];
        }

        if (verbose) {
            console.log(chalk.blue(`Debug - Config: ${JSON.stringify({
                projectId: config.projectId,
                sourceLocale: config.sourceLocale,
                outputLocales: config.outputLocales,
                translationFiles: {
                    paths: config.translationFiles.paths,
                    pattern: config.translationFiles.pattern,
                    ignore: config.translationFiles.ignore
                }
            }, null, 2)}`));
        }

        if (verbose) {
            console.log(chalk.blue('Finding translation files...'));
        }

        const allFiles = [];
        for (const basePath of config.translationFiles.paths) {
            if (verbose) {
                console.log(chalk.blue(`Searching in path: ${basePath}`));
            }
            const pattern = config.translationFiles.pattern || '**/*.{json,yml,yaml}';
            const globPattern = path.join(basePath, pattern);

            try {
                const files = await glob(globPattern, {
                    ignore: (config.translationFiles.ignore || []).map(i => path.join(basePath, i))
                });

                if (verbose) {
                    console.log(chalk.blue(`Found ${files.length} files in ${basePath}`));
                }

                for (const file of files) {
                    try {
                        const content = await fs.readFile(file, 'utf8');
                        const format = path.extname(file).slice(1).toLowerCase();

                        let locale;

                        const dirName = path.basename(path.dirname(file));
                        if (isValidLocale(dirName)) {
                            locale = dirName;
                        } else {
                            try {
                                locale = extractLocaleFromPath(file, DEFAULT_LOCALE_REGEX);
                            } catch {
                                log(chalk.yellow(`Could not determine locale for ${file}, skipping`));
                                continue;
                            }
                        }

                        allFiles.push({
                            path: file,
                            locale,
                            format,
                            content: Buffer.from(content).toString('base64')
                        });

                        if (verbose) {
                            console.log(chalk.blue(`Found file: ${file} (locale: ${locale})`));
                        }
                    } catch (error) {
                        if (verbose) {
                            console.log(chalk.yellow(`Error processing file ${file}: ${error.message}`));
                        }
                    }
                }
            } catch (globError) {
                console.error(chalk.red(`Error searching for files in ${basePath}: ${globError.message}`));
            }
        }

        if (allFiles.length === 0) {
            console.error(chalk.red('❌ No translation files found'));
            console.log(chalk.yellow('Make sure your configuration points to the correct directories:'));
            console.log(chalk.yellow(`Current paths: ${config.translationFiles.paths.join(', ')}`));
            console.log(chalk.yellow(`Current pattern: ${config.translationFiles.pattern || '**/*.{json,yml,yaml}'}`));
            process.exit(1);
        }

        console.log(chalk.green(`✓ Found ${allFiles.length} translation files`));

        const sourceFiles = allFiles.filter(file => {
            const isSourceFile = file.path.includes(`/${config.sourceLocale}/`) ||
                file.path.includes(`${config.sourceLocale}.`) ||
                file.locale === config.sourceLocale;

            if (isSourceFile) {
                if (verbose) {
                    console.log(chalk.blue(`Source file: ${file.path}`));
                }
            }

            return isSourceFile;
        });

        if (sourceFiles.length === 0) {
            console.error(chalk.red(`❌ No source files found for locale ${config.sourceLocale}`));
            console.log(chalk.yellow('Make sure your source files follow one of these patterns:'));
            console.log(chalk.yellow(`- locales/${config.sourceLocale}/common.json`));
            console.log(chalk.yellow(`- locales/common.${config.sourceLocale}.json`));
            console.log(chalk.yellow(`- locales/${config.sourceLocale}.json`));
            process.exit(1);
        }

        console.log(chalk.green(`✓ Found ${sourceFiles.length} source files for locale ${config.sourceLocale}`));

        const targetFiles = allFiles.filter(file => {
            for (const locale of config.outputLocales) {
                if (file.path.includes(`/${locale}/`) ||
                    file.path.includes(`${locale}.`) ||
                    file.locale === locale) {
                    file.locale = locale;
                    if (verbose) {
                        console.log(chalk.blue(`Target file for ${locale}: ${file.path}`));
                    }
                    return true;
                }
            }
            return false;
        });

        console.log(chalk.blue(`✓ Found ${targetFiles.length} target files for locales: ${config.outputLocales.join(', ')}, checking for missing translations...`));

        const missingByLocale = {};

        for (const sourceFile of sourceFiles) {
            const sourceContentRaw = Buffer.from(sourceFile.content, 'base64').toString();
            let sourceContent;

            try {
                sourceContent = parseFile(sourceContentRaw, sourceFile.format);
            } catch (error) {
                console.error(chalk.red(`❌ Error parsing ${sourceFile.path}: ${error.message}`));
                continue;
            }

            if (verbose) {
                console.log(chalk.gray(`Analyzing source file: ${sourceFile.path}`));
            }

            let sourceKeys = {};
            try {
                if (sourceFile.format === 'json') {
                    if (sourceContent[config.sourceLocale]) {
                        sourceKeys = flattenTranslations(sourceContent[config.sourceLocale]);
                    } else {
                        sourceKeys = flattenTranslations(sourceContent);
                    }
                } else {
                    if (sourceContent[config.sourceLocale]) {
                        sourceKeys = flattenTranslations(sourceContent[config.sourceLocale]);
                    } else {
                        sourceKeys = flattenTranslations(sourceContent);
                    }
                }

                if (verbose) {
                    console.log(chalk.gray(`Source file contains ${Object.keys(sourceKeys).length} keys`));
                    console.log(chalk.gray(`Source keys: ${JSON.stringify(Object.keys(sourceKeys).slice(0, 5))}...`));
                }
            } catch (error) {
                console.error(chalk.red(`Error parsing source file ${sourceFile.path}: ${error.message}`));
                continue;
            }

            for (const targetLocale of config.outputLocales) {
                const targetFile = targetFiles.find(f =>
                    f.locale === targetLocale &&
                    (path.dirname(f.path) === path.dirname(sourceFile.path) ||
                        path.basename(f.path, path.extname(f.path)) === path.basename(sourceFile.path, path.extname(sourceFile.path)).replace(config.sourceLocale, targetLocale))
                );

                let targetKeys = {};
                let targetPath = '';

                if (targetFile) {
                    try {
                        const targetContentRaw = Buffer.from(targetFile.content, 'base64').toString();
                        let targetContent;

                        try {
                            targetContent = parseFile(targetContentRaw, targetFile.format);
                        } catch (error) {
                            console.error(chalk.red(`❌ Error parsing ${targetFile.path}: ${error.message}`));
                            continue;
                        }

                        if (verbose) {
                            console.log(chalk.gray(`Analyzing target file: ${targetFile.path}`));
                        }

                        if (targetFile.format === 'json') {
                            if (targetContent[targetLocale]) {
                                log(chalk.gray(`Target file has language wrapper: ${targetLocale}`));
                                targetKeys = flattenTranslations(targetContent[targetLocale]);
                            } else {
                                targetKeys = flattenTranslations(targetContent);
                            }
                        } else {
                            if (targetContent[targetLocale]) {
                                targetKeys = flattenTranslations(targetContent[targetLocale]);
                            } else {
                                targetKeys = flattenTranslations(targetContent);
                            }
                        }

                        if (verbose) {
                            console.log(chalk.gray(`Target file contains ${Object.keys(targetKeys).length} keys`));
                            console.log(chalk.gray(`Target keys: ${JSON.stringify(Object.keys(targetKeys).slice(0, 5))}...`));
                        }

                        targetPath = targetFile.path;
                    } catch (error) {
                        console.error(chalk.red(`Error parsing target file ${targetFile.path}: ${error.message}`));
                        continue;
                    }
                } else {
                    const sourceExt = path.extname(sourceFile.path);
                    const sourceDir = path.dirname(sourceFile.path);
                    const sourceName = path.basename(sourceFile.path, sourceExt);

                    if (sourceName === config.sourceLocale) {
                        targetPath = path.join(sourceDir, `${targetLocale}${sourceExt}`);
                    } else if (sourceName.endsWith(`.${config.sourceLocale}`)) {
                        const baseName = sourceName.slice(0, -(config.sourceLocale.length + 1));
                        targetPath = path.join(sourceDir, `${baseName}.${targetLocale}${sourceExt}`);
                    } else if (sourceName.includes(`-${config.sourceLocale}`)) {
                        const baseName = sourceName.slice(0, -(config.sourceLocale.length + 1));
                        targetPath = path.join(sourceDir, `${baseName}-${targetLocale}${sourceExt}`);
                    } else {
                        const sourceParentDir = path.basename(sourceDir);
                        if (sourceParentDir === config.sourceLocale) {
                            const grandParentDir = path.dirname(sourceDir);
                            targetPath = path.join(grandParentDir, targetLocale, path.basename(sourceFile.path));
                        } else {
                            targetPath = sourceFile.path.replace(config.sourceLocale, targetLocale);
                        }
                    }

                    if (verbose) {
                        console.log(chalk.yellow(`No target file found for locale: ${targetLocale}, will create: ${targetPath}`));
                    }
                }

                const { missingKeys, skippedKeys } = translationUtils.findMissingTranslations(sourceKeys, targetKeys);
                const missingCount = Object.keys(missingKeys).length;
                const skippedCount = Object.keys(skippedKeys).length;

                if (verbose && skippedCount > 0) {
                    for (const [key] of Object.entries(skippedKeys)) {
                        console.log(chalk.yellow(`Skipping WIP key: ${key}`));
                    }
                }

                if (missingCount > 0) {
                    if (!missingByLocale[targetLocale]) {
                        missingByLocale[targetLocale] = {
                            keys: {},
                            path: sourceFile.path,
                            targetPath,
                            keyCount: missingCount
                        };
                    }

                    for (const [key, value] of Object.entries(missingKeys)) {
                        if (typeof value === 'string') {
                            missingByLocale[targetLocale].keys[key] = value;
                        } else if (value && typeof value === 'object') {
                            if (value.value !== undefined) {
                                missingByLocale[targetLocale].keys[key] = value.value;
                            } else {
                                missingByLocale[targetLocale].keys[key] = value;
                            }
                        } else {
                            missingByLocale[targetLocale].keys[key] = String(value);
                        }
                    }

                    if (verbose) {
                        console.log(chalk.blue(`${targetLocale}: ${missingCount} missing keys in ${path.basename(sourceFile.path)}`));
                        console.log(chalk.gray(`Missing keys: ${JSON.stringify(Object.keys(missingKeys).slice(0, 5))}...`));
                    }
                } else {
                    if (verbose) {
                        console.log(chalk.green(`${targetLocale}: No missing keys in ${path.basename(sourceFile.path)}`));
                    }
                }
            }
        }

        const { hasUpdates, updates } = await syncService.checkForUpdates({ verbose });

        if (Object.keys(missingByLocale).length === 0 && !hasUpdates) {
            console.log(chalk.green('✓ All translations are up to date!'));
            return;
        }

        if (hasUpdates) {
            console.log(chalk.blue('\nSyncing updates from the API...'));
            await syncService.applyUpdates(updates, { verbose });
        }

        if (Object.keys(missingByLocale).length > 0) {
            if (verbose) {
                console.log(chalk.cyan('\nMissing translations summary:'));
                for (const [locale, data] of Object.entries(missingByLocale)) {
                    console.log(chalk.cyan(`${locale}: ${data.keyCount} missing keys`));
                }
            }
            console.log(chalk.blue('\nTranslating missing keys...'));
        }

        const sourceFilesForTranslation = sourceFiles.map(file => ({
            path: file.path,
            format: file.format
        }));

        const { batches, errors } = translationUtils.batchKeysWithMissing(sourceFilesForTranslation, missingByLocale, BATCH_SIZE);

        if (errors.length > 0) {
            for (const error of errors) {
                if (error.type === 'missing_source_file') {
                    console.error(chalk.red(error.message));
                } else {
                    console.error(chalk.red(`Error: ${error.message}`));
                }
            }
        }

        let totalKeysProcessed = 0;
        let totalErrors = 0;
        let translationsUrl;

        for (const [batchIndex, batch] of batches.entries()) {
            if (verbose) {
                console.log(chalk.blue(`\nProcessing batch ${batchIndex + 1}/${batches.length}...`));
            }

            if (!config.projectId) {
                console.error(chalk.red('❌ Project ID is not defined in the configuration'));
                process.exit(1);
            }

            const jobRequest = {
                projectId: config.projectId,
                sourceFiles: batch.files,
                targetLocales: batch.locales
            };

            try {
                const response = await translationUtils.createTranslationJob(jobRequest);

                if (!response || !response.jobs) {
                    throw new Error('Invalid response from translation API: missing jobs');
                }

                const { jobs } = response;

                if (!Array.isArray(jobs) || jobs.length === 0) {
                    throw new Error('No translation jobs were created');
                }

                for (const job of jobs) {
                    let status;
                    let retries = 0;
                    const MAX_WAIT_MINUTES = 10;
                    const startTime = Date.now();

                    if (verbose) {
                        console.log(chalk.blue(`Waiting for job ${job.id} to complete...`));
                    }

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
                            console.log(chalk.blue(`  Job ${job.id} is ${status.status}, checking again in ${waitSeconds}s...`));
                            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                            retries = Math.min(retries + 1, 5);
                        }
                    } while (status.status === 'pending' || status.status === 'processing');

                    if (verbose) {
                        console.log(chalk.green(`✓ Job ${job.id} completed!`));
                    }

                    if (!status.translations) {
                        console.error(chalk.red(`❌ No translations returned for job ${job.id}`));
                        totalErrors++;
                        continue;
                    }

                    if (verbose) {
                        console.log(chalk.blue('Debug - Translations structure:'), JSON.stringify(status, null, 2));
                    }

                    let translationsToProcess = {};

                    if (status.translations && typeof status.translations === 'object') {
                        const keys = Object.keys(status.translations);

                        if (keys.includes('data')) {
                            const locale = status.language?.code ||
                                status.target_language?.code ||
                                status.target_locale ||
                                Object.keys(missingByLocale)[0];

                            if (locale && missingByLocale[locale]) {
                                translationsToProcess[locale] = status.translations.data || {};
                            }
                        }
                    }

                    for (const [locale, translations] of Object.entries(translationsToProcess)) {
                        console.log(chalk.blue(`Processing locale: ${locale}`));

                        const localeData = missingByLocale[locale];
                        if (!localeData) {
                            console.error(chalk.red(`❌ No locale data found for ${locale}`));
                            console.log(chalk.yellow('Available locales in missingByLocale:'), Object.keys(missingByLocale));
                            totalErrors++;
                            continue;
                        }

                        const targetPath = localeData.targetPath || localeData.path.replace(config.sourceLocale, locale);

                        try {
                            await translationUtils.updateTranslationFile(targetPath, translations, locale);

                            totalKeysProcessed += Object.keys(translations).length;
                            console.log(chalk.green(`✓ Updated translations for ${locale}`));

                            if (status.translations_url && !translationsUrl) {
                                translationsUrl = status.translations_url;
                            }
                        } catch (error) {
                            console.error(chalk.red(`Error updating translations for ${locale}:`), error);
                            console.error(error.stack);
                            totalErrors++;
                        }
                    }
                }
            } catch (error) {
                console.error(chalk.red(`❌ Error creating translation job: ${error.message}`));
                console.error(error.stack);
                process.exit(1);
            }
        }

        if (totalErrors > 0) {
            console.error(chalk.red(`\n❌ Translation completed with ${totalErrors} failed batches`));
            process.exit(1);
        }


        await configUtils.updateLastSyncedAt();

        if (commit) {
            console.log(chalk.blue('\nCommitting changes to git...'));
            try {
                await autoCommitChanges('Latest translations from LocalHero.ai');
                console.log(chalk.green('✓ Changes committed to git'));
            } catch (error) {
                console.error(chalk.red(`❌ Error committing changes: ${error.message}`));
                console.error(error.stack);
            }
        }

        const updatedLocales = new Set(Object.keys(missingByLocale));
        console.log(chalk.green('\n✓ Translations complete!') + ` Updated ${totalKeysProcessed} keys in ${updatedLocales.size} languages`);

        if (translationsUrl) {
            console.log(chalk.blue(`\nView your translations at: ${translationsUrl}`));
        }
    } catch (error) {
        console.error(chalk.red(`❌ Error: ${error.message}`));
        console.error(error.stack);
        process.exit(1);
    }
}