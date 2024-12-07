import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'yaml';

function getExistingQuoteStyles(content) {
    const styles = new Map();

    // Pre-split lines and get non-empty, non-comment lines
    const lines = content.match(/[^\n]+/g) || [];
    let currentPath = new Array(10); // Pre-allocate array with reasonable size
    let pathLength = 0;

    // Regex patterns - compile once
    const indentRegex = /^\s*/;
    const keyValueRegex = /^([^:]+):\s*(.*)$/;
    const doubleQuoteRegex = /^"(.*)"$/;
    const singleQuoteRegex = /^'(.*)'$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim().startsWith('#')) continue;

        // Calculate indent level
        const indent = line.match(indentRegex)[0].length;
        const level = indent >> 1; // Divide by 2 using bit shift

        // Adjust current path
        pathLength = level;

        // Extract key and value
        const match = line.trim().match(keyValueRegex);
        if (match) {
            const key = match[1].trim();
            const value = match[2];

            currentPath[level] = key;

            // Only process if there's a value
            if (value) {
                // Build path string only when needed
                const fullPath = currentPath.slice(0, pathLength + 1).join('.');

                // Check quote style
                const valueTrimed = value.trim();
                const hasDoubleQuotes = doubleQuoteRegex.test(valueTrimed);
                const hasSingleQuotes = !hasDoubleQuotes && singleQuoteRegex.test(valueTrimed);

                if (hasDoubleQuotes || hasSingleQuotes || valueTrimed) {
                    styles.set(fullPath, {
                        quoted: hasDoubleQuotes || hasSingleQuotes,
                        quoteType: hasDoubleQuotes ? '"' : (hasSingleQuotes ? "'" : ''),
                        originalValue: valueTrimed
                    });
                }
            }
        }
    }

    return styles;
}

// Cache for repeated string operations
const SPECIAL_CHARS_REGEX = /[:@#,\[\]{}?|>&*!\n]/;
const INTERPOLATION = '%{';
const INDENT_CACHE = new Map();

function getIndent(level) {
    let indent = INDENT_CACHE.get(level);
    if (!indent) {
        indent = ' '.repeat(level);
        INDENT_CACHE.set(level, indent);
    }
    return indent;
}

function stringifyYaml(obj, indent = 0, parentPath = '', result = []) {
    const indentStr = getIndent(indent);

    for (const [key, value] of Object.entries(obj)) {
        const currentPath = parentPath ? `${parentPath}.${key}` : key;

        if (value && typeof value === 'object') {
            result.push(`${indentStr}${key}:`);
            stringifyYaml(value, indent + 2, currentPath, result);
        } else {
            let formattedValue = value;

            if (typeof value === 'string') {
                const existingStyle = existingStyles.get(currentPath);

                if (existingStyle?.quoted) {
                    formattedValue = `${existingStyle.quoteType}${value}${existingStyle.quoteType}`;
                } else if (existingStyle?.originalValue === value) {
                    formattedValue = existingStyle.originalValue;
                } else if (value.includes(INTERPOLATION) || SPECIAL_CHARS_REGEX.test(value)) {
                    formattedValue = `"${value}"`;
                }
            }

            result.push(`${indentStr}${key}: ${formattedValue}`);
        }
    }

    return result;
}

// Store styles globally to avoid passing as parameter
let existingStyles;

export async function updateTranslationFile(filePath, translations, languageCode) {
    try {
        if (path.extname(filePath).slice(1) === 'json') {
            // Handle JSON (existing code)
            return;
        }

        let existingContent = '';
        try {
            existingContent = await fs.readFile(filePath, 'utf8');
            existingStyles = getExistingQuoteStyles(existingContent);
        } catch (error) {
            console.warn(`Creating new file: ${filePath}`);
            existingStyles = new Map();
        }

        const hasTrailingSpace = /\s$/.test(existingContent);

        // Parse existing content
        const yamlContent = yaml.parse(existingContent) || {};
        yamlContent[languageCode] = yamlContent[languageCode] || {};

        // Update translations efficiently
        for (const [keyPath, newValue] of Object.entries(translations)) {
            const keys = keyPath.split('.');
            let current = yamlContent[languageCode];
            const lastIndex = keys.length - 1;

            for (let i = 0; i < lastIndex; i++) {
                const key = keys[i];
                current[key] = current[key] || {};
                current = current[key];
            }

            current[keys[lastIndex]] = newValue;
        }

        const content = stringifyYaml(yamlContent);
        const finalContent = content.join('\n') + (hasTrailingSpace ? ' ' : '');

        await fs.writeFile(filePath, finalContent);
        return Object.keys(translations);

    } catch (error) {
        throw new Error(`Failed to update translation file ${filePath}: ${error.message}`);
    }
}