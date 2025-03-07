import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { createImport, checkImportStatus } from '../api/imports.js';
import { flattenTranslations } from './files.js';

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
            // Flatten the JSON content for API
            const flattened = flattenTranslations(jsonContent);
            return Buffer.from(JSON.stringify(flattened)).toString('base64');
        } catch {
            // If parsing fails, just return the content as is
            return Buffer.from(content).toString('base64');
        }
    }

    return Buffer.from(content).toString('base64');
}

function getLanguageFromPath(filePath, sourceLocale) {
    const fileName = path.basename(filePath, path.extname(filePath));
    const dirName = path.basename(path.dirname(filePath));
    const parentDirName = path.basename(path.dirname(path.dirname(filePath)));

    // Pattern 1: /path/to/en/common.json (language as directory name)
    if (/^[a-z]{2}(-[A-Z]{2})?$/.test(dirName)) {
        // Check if the filename might be a namespace
        if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(fileName)) {
            return dirName;
        }
    }

    // Pattern 2: /path/to/common.en.json (language in filename with dot)
    const dotMatch = fileName.match(/(.+)\.([a-z]{2}(?:-[A-Z]{2})?)$/);
    if (dotMatch && dotMatch[2]) {
        return dotMatch[2];
    }

    // Pattern 3: /path/to/common-en.json (language in filename with dash)
    const dashMatch = fileName.match(/(.+)-([a-z]{2}(?:-[A-Z]{2})?)$/);
    if (dashMatch && dashMatch[2]) {
        return dashMatch[2];
    }

    // Pattern 4: /path/to/locales/en.json (language as filename)
    if (/^[a-z]{2}(-[A-Z]{2})?$/.test(fileName)) {
        return fileName;
    }

    // Pattern 5: /path/to/en/locales/common.json (language as parent directory)
    if (/^[a-z]{2}(-[A-Z]{2})?$/.test(parentDirName)) {
        return parentDirName;
    }

    // If no pattern matches, check if the filename matches the source locale
    if (fileName === sourceLocale) {
        return sourceLocale;
    }

    // Default to the filename if no other pattern matches
    return fileName;
}

export const importService = {
    async findTranslationFiles(config, basePath = process.cwd()) {
        const { translationFiles, sourceLocale } = config;
        const { paths, ignore = [], pattern = '**/*.{json,yml,yaml}' } = translationFiles;

        const allFiles = [];
        for (const translationPath of paths) {
            const fullPath = path.join(basePath, translationPath);
            const globPattern = path.join(fullPath, pattern);

            const files = await glob(globPattern, {
                ignore: ignore.map(p => path.join(basePath, p)),
                nodir: true
            });

            allFiles.push(...files);
        }

        return allFiles.map(file => {
            const relativePath = path.relative(basePath, file);
            const language = getLanguageFromPath(file, sourceLocale);
            const format = getFileFormat(file);

            // Extract namespace from the file path
            let namespace = '';
            const fileName = path.basename(file, path.extname(file));

            // Pattern 1: /path/to/en/common.json -> namespace = common
            if (/^[a-z]{2}(-[A-Z]{2})?$/.test(path.basename(path.dirname(file)))) {
                namespace = fileName;
            }

            // Pattern 2: /path/to/common.en.json -> namespace = common
            const dotMatch = fileName.match(/^(.+)\.([a-z]{2}(?:-[A-Z]{2})?)$/);
            if (dotMatch) {
                namespace = dotMatch[1];
            }

            // Pattern 3: /path/to/common-en.json -> namespace = common
            const dashMatch = fileName.match(/^(.+)-([a-z]{2}(?:-[A-Z]{2})?)$/);
            if (dashMatch) {
                namespace = dashMatch[1];
            }

            return {
                path: relativePath,
                language,
                format,
                namespace
            };
        });
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

        // Group all files by language and namespace for better organization
        const allTranslations = [];

        // Add source files
        for (const file of sourceFiles) {
            allTranslations.push({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(path.join(basePath, file.path))
            });
        }

        // Add target files
        for (const file of targetFiles) {
            allTranslations.push({
                language: file.language,
                format: file.format,
                filename: file.path,
                content: await readFileContent(path.join(basePath, file.path))
            });
        }

        // Send all files in a single API call
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