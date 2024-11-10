import { glob } from 'glob';
import { readFile } from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

function parseFile(content, format) {
    try {
        if (format === 'json') {
            return JSON.parse(content);
        }
        return yaml.parse(content);
    } catch (error) {
        throw new Error(`Failed to parse ${format} file: ${error.message}`);
    }
}

function extractKeysWithContext(obj, parentKeys = [], result = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const currentPath = [...parentKeys, key];
        const fullKey = currentPath.join('.');

        if (typeof value === 'object' && value !== null) {
            extractKeysWithContext(value, currentPath, result);
        } else {
            const siblings = {};
            const parentObj = parentKeys.length ?
                parentKeys.reduce((acc, key) => acc[key], obj) :
                obj;

            Object.entries(parentObj)
                .filter(([k, v]) => k !== key && typeof v !== 'object')
                .forEach(([k, v]) => {
                    siblings[`${parentKeys.join('.')}.${k}`] = v;
                });

            result[fullKey] = {
                value: value,
                context: {
                    parent_keys: parentKeys,
                    sibling_keys: siblings
                }
            };
        }
    }
    return result;
}

function extractLocaleFromPath(filePath, localeRegex) {
    const match = path.basename(filePath).match(new RegExp(localeRegex));
    if (!match || !match[1]) {
        throw new Error(`Could not extract locale from filename: ${filePath}`);
    }
    return match[1].toLowerCase();
}

function flattenTranslations(obj, parentKey = '') {
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

export async function findTranslationFiles(translationPath, localeRegex) {
    const pattern = path.join(translationPath, '**/*.{yml,yaml,json}');
    const files = await glob(pattern, { absolute: true });

    return Promise.all(files.map(async (filePath) => {
        try {
            const locale = extractLocaleFromPath(filePath, localeRegex);
            const content = await readFile(filePath, 'utf8');
            const format = path.extname(filePath).slice(1);
            const parsedContent = parseFile(content, format);

            // Extract translations, handling both nested and flat structures
            let translations;
            if (parsedContent[locale]) {
                // Nested under locale key (common in Rails/YAML)
                translations = flattenTranslations(parsedContent[locale]);
            } else {
                // Flat structure (common in JSON)
                translations = flattenTranslations(parsedContent);
            }

            // Extract keys with context
            const keys = {};
            for (const [key, value] of Object.entries(translations)) {
                const parts = key.split('.');
                const parentKeys = parts.slice(0, -1);

                // Get sibling translations
                const siblings = {};
                Object.entries(translations)
                    .filter(([k, v]) => {
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

            const formattedContent = {
                keys,
                metadata: {
                    source_language: locale
                }
            };

            return {
                path: filePath,
                locale,
                format,
                content: Buffer.from(JSON.stringify(formattedContent)).toString('base64')
            };
        } catch (error) {
            console.error(chalk.yellow(`⚠️  Skipping ${filePath}: ${error.message}`));
            return null;
        }
    })).then(results => results.filter(Boolean));
} 