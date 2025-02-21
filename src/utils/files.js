import chalk from 'chalk';
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

function extractLocaleFromPath(filePath, localeRegex) {
    const filename = path.basename(filePath);
    const match = filename.match(new RegExp(localeRegex));

    if (!match || !match[1]) {
        throw new Error(`Could not extract locale from filename: ${filePath}`);
    }

    const locale = match[1].toLowerCase();

    // Basic validation of locale format (2 letter code)
    if (!/^[a-z]{2}$/.test(locale)) {
        throw new Error(`Invalid locale format in filename: ${filePath}. Expected 2-letter language code.`);
    }

    return locale;
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
    const safeRegex = localeRegex.startsWith('^') ? localeRegex : `^${localeRegex}`;
    const pattern = path.join(translationPath, '**/*.{yml,yaml,json}');
    const files = await glob(pattern, { absolute: true });

    return Promise.all(files.map(async (filePath) => {
        try {
            const locale = extractLocaleFromPath(filePath, safeRegex);
            const content = await readFile(filePath, 'utf8');
            const format = path.extname(filePath).slice(1);
            const parsedContent = parseFile(content, format);

            let translations;
            if (parsedContent[locale]) {
                translations = flattenTranslations(parsedContent[locale]);
            } else {
                translations = flattenTranslations(parsedContent);
            }

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