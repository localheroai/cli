export function findMissingTranslations(sourceKeys, targetKeys) {
    const missingKeys = {};
    const skippedKeys = {};

    for (const [key, details] of Object.entries(sourceKeys)) {
        if (typeof details === 'string') {
            if (
                details.toLowerCase().includes('wip_') ||
                details.toLowerCase().includes('_wip') ||
                details.toLowerCase().includes('__skip_translation__')
            ) {
                skippedKeys[key] = {
                    value: details,
                    reason: 'wip'
                };
                continue;
            }

            if (!targetKeys[key]) {
                missingKeys[key] = {
                    value: details,
                    sourceKey: key
                };
            }
            continue;
        }

        if (
            typeof details.value === 'string' &&
            (details.value.toLowerCase().includes('wip_') || details.value.toLowerCase().includes('_wip') ||
                details.value.toLowerCase().includes('__skip_translation__'))
        ) {
            skippedKeys[key] = {
                ...details,
                reason: 'wip'
            };
            continue;
        }

        if (!targetKeys[key]) {
            missingKeys[key] = {
                ...details,
                sourceKey: key
            };
        }
    }

    return { missingKeys, skippedKeys };
}


export function batchKeysWithMissing(sourceFiles, missingByLocale, batchSize = 100) {
    const batches = [];
    const errors = [];
    const sourceFileEntries = new Map();

    for (const [locale, localeData] of Object.entries(missingByLocale)) {
        const sourceFile = sourceFiles.find(f => f.path === localeData.path);
        if (!sourceFile) {
            errors.push({
                type: 'missing_source_file',
                message: `No source file found for path: ${localeData.path}`,
                locale,
                path: localeData.path
            });
            continue;
        }

        if (!sourceFileEntries.has(sourceFile.path)) {
            sourceFileEntries.set(sourceFile.path, {
                path: sourceFile.path,
                format: sourceFile.format || 'json',
                keys: {},
                locales: new Set()
            });
        }

        const entry = sourceFileEntries.get(sourceFile.path);

        const formattedKeys = {};
        for (const [key, value] of Object.entries(localeData.keys)) {
            let extractedValue;

            if (typeof value === 'string') {
                extractedValue = value;
            } else if (typeof value === 'object' && value !== null) {
                if (value.value !== undefined) {
                    extractedValue = value.value;
                } else if (Object.keys(value).some(k => !isNaN(parseInt(k, 10)))) {
                    let reconstructedString = '';
                    let i = 0;
                    while (value[i] !== undefined) {
                        reconstructedString += value[i];
                        i++;
                    }
                    extractedValue = reconstructedString;
                } else {
                    extractedValue = JSON.stringify(value);
                }
            } else {
                extractedValue = String(value);
            }

            if (typeof extractedValue !== 'string') {
                extractedValue = String(extractedValue);
            }

            formattedKeys[key] = extractedValue;
        }

        entry.keys = { ...entry.keys, ...formattedKeys };
        entry.locales.add(locale);
    }

    for (const entry of sourceFileEntries.values()) {
        const keyEntries = Object.entries(entry.keys);

        for (let i = 0; i < keyEntries.length; i += batchSize) {
            const batchKeys = Object.fromEntries(keyEntries.slice(i, i + batchSize));

            const contentObj = { keys: {} };
            for (const [key, value] of Object.entries(batchKeys)) {
                const stringValue = String(value);

                contentObj.keys[key] = {
                    value: stringValue,
                    context: {
                        parent_keys: key.split('.').slice(0, -1),
                        sibling_keys: {}
                    }
                };
            }

            batches.push({
                files: [{
                    path: entry.path,
                    format: entry.format,
                    content: Buffer.from(JSON.stringify(contentObj)).toString('base64')
                }],
                locales: Array.from(entry.locales)
            });
        }
    }

    return { batches, errors };
} 