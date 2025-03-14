import { promises as fs } from 'fs';
import path from 'path';
import { createImport, checkImportStatus } from '../api/imports.js';
import { findTranslationFiles, flattenTranslations } from './files.js';

function getFileFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.yml' || ext === '.yaml') return 'yaml';
    return null;
}

async function readFileContent(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const format = getFileFormat(filePath);

    if (format === 'json') {
        try {
            const jsonContent = JSON.parse(content);
            const flattened = flattenTranslations(jsonContent);

            return Buffer.from(JSON.stringify(flattened)).toString('base64');
        } catch {
            return Buffer.from(content).toString('base64');
        }
    }

    return Buffer.from(content).toString('base64');
}

export const importService = {
    async findTranslationFiles(config, basePath = process.cwd()) {
        // Use the enhanced utility instead of duplicating code
        const files = await findTranslationFiles(config, {
            basePath,
            parseContent: false,
            includeContent: false,
            extractKeys: false,
            includeNamespace: true
        });

        return files.map(file => ({
            path: path.isAbsolute(file.path) ? path.relative(basePath, file.path) : file.path,
            language: file.locale,
            format: file.format,
            namespace: file.namespace || ''
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

        const allTranslations = [];

        for (const file of sourceFiles) {
            const fullPath = path.join(basePath, file.path);
            allTranslations.push({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(fullPath)
            });
        }

        for (const file of targetFiles) {
            const fullPath = path.join(basePath, file.path);
            allTranslations.push({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(fullPath)
            });
        }

        const importResult = await createImport({
            projectId: config.projectId,
            translations: allTranslations
        });

        if (importResult.status === 'failed') {
            return {
                ...importResult,
                files: importedFiles
            };
        }

        let finalImportResult = importResult;
        while (finalImportResult.status === 'processing') {
            await new Promise(resolve => setTimeout(resolve, finalImportResult.poll_interval * 1000));
            finalImportResult = await checkImportStatus(config.projectId, finalImportResult.id);

            if (finalImportResult.status === 'failed') {
                return {
                    ...finalImportResult,
                    files: importedFiles
                };
            }
        }

        return {
            ...finalImportResult,
            files: importedFiles
        };
    }
}; 