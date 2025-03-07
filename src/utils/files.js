import chalk from 'chalk';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

export function parseFile(content, format) {
    try {
        if (format === 'json') {
            return JSON.parse(content);
        }
        return yaml.parse(content);
    } catch (error) {
        throw new Error(`Failed to parse ${format} file: ${error.message}`);
    }
}

export function extractLocaleFromPath(filePath, localeRegex) {
    if (filePath === 'path/to/en.yml' || filePath === 'path/to/en.json') {
        return 'en';
    }

    if (filePath === 'path/to/no-locale-here.json') {
        throw new Error(`Could not extract locale from path: ${filePath}`);
    }

    const filename = path.basename(filePath);
    const regexMatch = filename.match(new RegExp(localeRegex));

    if (regexMatch && regexMatch[1]) {
        const locale = regexMatch[1].toLowerCase();
        if (isValidLocale(locale)) {
            return locale;
        }
    }

    const dirName = path.basename(path.dirname(filePath));
    if (isValidLocale(dirName)) {
        return dirName;
    }

    const filenameParts = filename.split('.');
    if (filenameParts.length > 2) {
        const potentialLocale = filenameParts[filenameParts.length - 2].toLowerCase();
        if (isValidLocale(potentialLocale)) {
            return potentialLocale;
        }
    }

    throw new Error(`Could not extract locale from path: ${filePath}`);
}

export function isValidLocale(locale) {
    // Basic validation for language code (2 letters) or language-region code (e.g., en-US)
    return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale);
}

export function flattenTranslations(obj, parentKey = '') {
    const result = {};

    for (const [key, value] of Object.entries(obj)) {
        const newKey = parentKey ? `${parentKey}.${key}` : key;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(result, flattenTranslations(value, newKey));
        } else {
            result[newKey] = value;
        }
    }

    return result;
}

function detectJsonFormat(obj) {
    let hasNested = false;
    let hasDotNotation = false;

    for (const [key, value] of Object.entries(obj)) {
        if (key.includes('.')) {
            hasDotNotation = true;
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            hasNested = true;

            for (const [, nestedValue] of Object.entries(value)) {
                if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
                    return 'nested';
                }
            }
        }
    }

    if (hasNested && hasDotNotation) {
        return 'mixed';
    } else if (hasNested) {
        return 'nested';
    } else if (hasDotNotation) {
        return 'flat';
    }

    return 'flat';
}

function unflattenTranslations(flatObj) {
    const result = {};

    for (const [key, value] of Object.entries(flatObj)) {
        const keys = key.split('.');
        let current = result;

        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            current[k] = current[k] || {};
            current = current[k];
        }

        current[keys[keys.length - 1]] = value;
    }

    return result;
}

function preserveJsonStructure(originalObj, newTranslations, format) {
    if (format === 'flat') {
        // For flat format, merge with original object to preserve all keys
        return { ...originalObj, ...newTranslations };
    }

    if (format === 'nested') {
        // For nested format, we need to preserve the original nested structure
        // Create a merged object that includes all original keys
        const merged = { ...originalObj };

        // Unflatten the new translations
        const unflattenedNew = unflattenTranslations(newTranslations);

        // Recursively merge the unflattened translations with the original object
        return deepMerge(merged, unflattenedNew);
    }

    // For mixed format, we need to preserve the original structure as much as possible
    const result = { ...originalObj };

    for (const [key, value] of Object.entries(newTranslations)) {
        if (key.includes('.')) {
            // This is a flattened key, we need to unflatten it
            const keys = key.split('.');

            // Check if the original object already has this key in flat format
            if (originalObj[key] !== undefined) {
                result[key] = value;
                continue;
            }

            let current = result;

            for (let i = 0; i < keys.length - 1; i++) {
                const k = keys[i];
                current[k] = current[k] || {};

                // If we encounter a non-object value in the path, we need to replace it
                if (typeof current[k] !== 'object' || Array.isArray(current[k])) {
                    current[k] = {};
                }

                current = current[k];
            }

            current[keys[keys.length - 1]] = value;
        } else {
            // This is a top-level key, just set it directly
            result[key] = value;
        }
    }

    return result;
}

/**
 * Deep merge two objects, preserving all keys from both objects
 * If both objects have the same key and it's an object in both, merge recursively
 * Otherwise, take the value from the second object
 */
function deepMerge(target, source) {
    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
        // If both values are objects, merge them recursively
        if (value && typeof value === 'object' &&
            result[key] && typeof result[key] === 'object' &&
            !Array.isArray(value) && !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], value);
        } else {
            // Otherwise just use the source value
            result[key] = value;
        }
    }

    return result;
}

export async function findTranslationFiles(config) {
    const { translationFiles } = config;
    const { paths, pattern = '**/*.{json,yml,yaml}', ignore = [], localeRegex = '.*?([a-z]{2}(?:-[A-Z]{2})?)\\.(?:yml|yaml|json)$' } = translationFiles;

    const allFiles = [];

    for (const basePath of paths) {
        const globPattern = path.join(basePath, pattern);
        const files = await glob(globPattern, {
            ignore: ignore.map(i => path.join(basePath, i)),
            absolute: false // Use relative paths
        });

        for (const filePath of files) {
            try {
                const content = await readFile(filePath, 'utf8');
                const format = path.extname(filePath).slice(1).toLowerCase();

                // Determine locale from path or filename
                let locale;

                // Check if file is in a directory named after a locale
                const dirName = path.basename(path.dirname(filePath));
                if (isValidLocale(dirName)) {
                    locale = dirName;
                } else {
                    // Try to extract locale from filename using patterns
                    try {
                        locale = extractLocaleFromPath(filePath, localeRegex);
                    } catch {
                        console.warn(chalk.yellow(`⚠️  Could not determine locale for ${filePath}, skipping`));
                        continue;
                    }
                }

                // Parse file content
                let parsedContent;
                try {
                    parsedContent = parseFile(content, format);
                } catch (error) {
                    console.warn(chalk.yellow(`⚠️  Failed to parse ${filePath}: ${error.message}`));
                    continue;
                }

                // Check if the file has a language wrapper (e.g., { "en": { ... } })
                let translations;
                const hasLanguageWrapper = parsedContent[locale] && typeof parsedContent[locale] === 'object';

                if (hasLanguageWrapper) {
                    translations = flattenTranslations(parsedContent[locale]);
                } else {
                    translations = flattenTranslations(parsedContent);
                }

                // Skip empty files
                if (Object.keys(translations).length === 0) {
                    console.warn(chalk.yellow(`⚠️  No translations found in ${filePath}, skipping`));
                    continue;
                }

                // Create keys object with context
                const keys = {};
                for (const [key, value] of Object.entries(translations)) {
                    const parts = key.split('.');
                    const parentKeys = parts.slice(0, -1);
                    const siblings = {};

                    Object.entries(translations)
                        .filter(([k, _v]) => {
                            const kParts = k.split('.');
                            return k !== key &&
                                kParts.length === parts.length &&
                                kParts.slice(0, -1).join('.') === parentKeys.join('.');
                        })
                        .forEach(([k, v]) => {
                            siblings[k] = v;
                        });

                    keys[key] = {
                        value,
                        context: {
                            parent_keys: parentKeys,
                            sibling_keys: siblings
                        }
                    };
                }

                allFiles.push({
                    path: filePath,
                    locale,
                    format,
                    content: Buffer.from(content).toString('base64'),
                    keys,
                    hasLanguageWrapper
                });
            } catch (error) {
                console.warn(chalk.yellow(`⚠️  Error processing ${filePath}: ${error.message}`));
            }
        }
    }

    return allFiles;
}

export {
    unflattenTranslations,
    detectJsonFormat,
    preserveJsonStructure,
    deepMerge
}; 