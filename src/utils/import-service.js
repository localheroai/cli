import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { createImport, checkImportStatus } from '../api/imports.js';

function getFileFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.yml' || ext === '.yaml') return 'yaml';
    return null;
}

async function readFileContent(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    return Buffer.from(content).toString('base64');
}

function getLanguageFromPath(filePath, sourceLocale) {
    const fileName = path.basename(filePath, path.extname(filePath));
    return fileName === sourceLocale ? sourceLocale : fileName;
}

export const importService = {
    async findTranslationFiles(config, basePath = process.cwd()) {
        const { translationFiles, sourceLocale } = config;
        const { paths, ignore = [] } = translationFiles;

        const allFiles = [];
        for (const translationPath of paths) {
            const fullPath = path.join(basePath, translationPath);
            const pattern = path.join(fullPath, '**/*.{json,yml,yaml}');

            const files = await glob(pattern, {
                ignore: ignore.map(p => path.join(basePath, p)),
                nodir: true
            });

            allFiles.push(...files);
        }

        return allFiles.map(file => ({
            path: path.relative(basePath, file),
            language: getLanguageFromPath(file, sourceLocale),
            format: getFileFormat(file)
        }));
    },

    async importTranslations(config, basePath = process.cwd()) {
        const files = await this.findTranslationFiles(config, basePath);

        if (!files.length) {
            return { status: 'no_files' };
        }

        const sourceFiles = files.filter(file => file.language === config.sourceLocale);
        const targetFiles = files.filter(file => file.language !== config.sourceLocale);
        const importedFiles = {
            source: sourceFiles,
            target: targetFiles
        };

        if (!sourceFiles.length) {
            return {
                status: 'failed',
                error: 'No source language files found. Source language files must be included in the first import.',
                files: importedFiles
            };
        }

        // First import: source language files
        const sourceTranslations = await Promise.all(
            sourceFiles.map(async file => ({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(path.join(basePath, file.path))
            }))
        );

        const sourceImport = await createImport({
            projectId: config.projectId,
            translations: sourceTranslations
        });

        if (sourceImport.status === 'failed') {
            return sourceImport;
        }

        let finalSourceImport = sourceImport;
        while (finalSourceImport.status === 'processing') {
            await new Promise(resolve => setTimeout(resolve, finalSourceImport.poll_interval * 1000));
            finalSourceImport = await checkImportStatus(config.projectId, finalSourceImport.id);

            if (finalSourceImport.status === 'failed') {
                return finalSourceImport;
            }
        }

        if (!targetFiles.length) {
            return { ...finalSourceImport, files: importedFiles };
        }

        // Second import: target language files
        const targetTranslations = await Promise.all(
            targetFiles.map(async file => ({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(path.join(basePath, file.path))
            }))
        );

        const targetImport = await createImport({
            projectId: config.projectId,
            translations: targetTranslations
        });

        if (targetImport.status === 'completed') {
            return {
                ...targetImport,
                sourceImport: finalSourceImport,
                files: importedFiles
            };
        }

        let finalTargetImport = targetImport;
        while (finalTargetImport.status === 'processing') {
            await new Promise(resolve => setTimeout(resolve, finalTargetImport.poll_interval * 1000));
            finalTargetImport = await checkImportStatus(config.projectId, finalTargetImport.id);

            if (finalTargetImport.status !== 'processing') {
                return {
                    ...finalTargetImport,
                    sourceImport: finalSourceImport,
                    files: importedFiles
                };
            }
        }

        return {
            ...finalTargetImport,
            sourceImport: finalSourceImport,
            files: importedFiles
        };
    }
}; 