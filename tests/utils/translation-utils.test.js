import { describe, it, expect } from '@jest/globals';
import { findMissingTranslations, batchKeysWithMissing } from '../../src/utils/translation-utils.js';

describe('translation-utils', () => {
    describe('findMissingTranslations', () => {
        it('should find missing keys', () => {
            const sourceKeys = {
                hello: { value: 'Hello' },
                world: { value: 'World' },
                welcome: { value: 'Welcome' }
            };

            const targetKeys = {
                hello: { value: 'Hola' },
                welcome: { value: 'Bienvenido' }
            };

            const result = findMissingTranslations(sourceKeys, targetKeys);

            expect(result.missingKeys).toEqual({
                world: {
                    value: 'World',
                    sourceKey: 'world'
                }
            });
            expect(result.skippedKeys).toEqual({});
        });

        it('should skip WIP keys with wip_ prefix', () => {
            const sourceKeys = {
                hello: { value: 'Hello' },
                wip_feature: { value: 'wip_This is a work in progress' }
            };

            const targetKeys = {
                hello: { value: 'Hola' }
            };

            const result = findMissingTranslations(sourceKeys, targetKeys);

            // The WIP key should be skipped, so no missing keys
            expect(result.missingKeys).toEqual({});
            expect(result.skippedKeys).toEqual({
                wip_feature: {
                    value: 'wip_This is a work in progress',
                    reason: 'wip'
                }
            });
        });

        it('should skip WIP keys with _wip suffix', () => {
            const sourceKeys = {
                hello: { value: 'Hello' },
                feature: { value: 'This is a work in progress_wip' }
            };

            const targetKeys = {
                hello: { value: 'Hola' }
            };

            const result = findMissingTranslations(sourceKeys, targetKeys);

            // The WIP key should be skipped, so no missing keys
            expect(result.missingKeys).toEqual({});
            expect(result.skippedKeys).toEqual({
                feature: {
                    value: 'This is a work in progress_wip',
                    reason: 'wip'
                }
            });
        });

        it('should skip keys with __skip_translation__ marker', () => {
            const sourceKeys = {
                hello: { value: 'Hello' },
                skip_me: { value: '__skip_translation__' }
            };

            const targetKeys = {
                hello: { value: 'Hola' }
            };

            const result = findMissingTranslations(sourceKeys, targetKeys);

            // The skip key should be skipped, so no missing keys
            expect(result.missingKeys).toEqual({});
            expect(result.skippedKeys).toEqual({
                skip_me: {
                    value: '__skip_translation__',
                    reason: 'wip'
                }
            });
        });

        it('should handle both missing and skipped keys', () => {
            const sourceKeys = {
                hello: { value: 'Hello' },
                world: { value: 'World' },
                wip_feature: { value: 'wip_This is a work in progress' },
                skip_me: { value: '__skip_translation__' }
            };

            const targetKeys = {
                hello: { value: 'Hola' }
            };

            const result = findMissingTranslations(sourceKeys, targetKeys);

            expect(result.missingKeys).toEqual({
                world: {
                    value: 'World',
                    sourceKey: 'world'
                }
            });

            expect(result.skippedKeys).toEqual({
                wip_feature: {
                    value: 'wip_This is a work in progress',
                    reason: 'wip'
                },
                skip_me: {
                    value: '__skip_translation__',
                    reason: 'wip'
                }
            });
        });
    });

    describe('batchKeysWithMissing', () => {
        it('should create batches from missing keys', () => {
            // Mock source files
            const sourceFiles = [
                {
                    path: 'locales/en.json',
                    format: 'json'
                }
            ];

            // Mock missing keys by locale
            const missingByLocale = {
                fr: {
                    path: 'locales/en.json',
                    keys: {
                        'hello': 'Hello',
                        'world': 'World'
                    }
                },
                es: {
                    path: 'locales/en.json',
                    keys: {
                        'hello': 'Hello',
                        'goodbye': 'Goodbye'
                    }
                }
            };

            // Call the function
            const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);

            // Verify the result
            expect(errors).toEqual([]);
            expect(batches).toHaveLength(1);

            // Verify the batch structure
            const batch = batches[0];
            expect(batch.files).toHaveLength(1);
            expect(batch.files[0].path).toBe('locales/en.json');
            expect(batch.files[0].format).toBe('json');

            // Verify the batch content
            const content = JSON.parse(Buffer.from(batch.files[0].content, 'base64').toString());
            expect(content.keys).toBeDefined();
            expect(Object.keys(content.keys)).toHaveLength(3); // hello, world, goodbye
            expect(content.keys.hello).toBeDefined();
            expect(content.keys.world).toBeDefined();
            expect(content.keys.goodbye).toBeDefined();

            // Verify the locales
            expect(batch.locales).toContain('fr');
            expect(batch.locales).toContain('es');
        });

        it('should handle missing source files', () => {
            // Mock source files
            const sourceFiles = [
                {
                    path: 'locales/en.json',
                    format: 'json'
                }
            ];

            // Mock missing keys by locale with a non-existent source file
            const missingByLocale = {
                fr: {
                    path: 'locales/en.json',
                    keys: {
                        'hello': 'Hello'
                    }
                },
                es: {
                    path: 'locales/non-existent.json',
                    keys: {
                        'hello': 'Hello'
                    }
                }
            };

            // Call the function
            const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);

            // Verify the result
            expect(errors).toHaveLength(1);
            expect(errors[0].type).toBe('missing_source_file');
            expect(errors[0].locale).toBe('es');
            expect(errors[0].path).toBe('locales/non-existent.json');

            // Verify that we still have batches for the valid source file
            expect(batches).toHaveLength(1);
            expect(batches[0].files[0].path).toBe('locales/en.json');
            expect(batches[0].locales).toContain('fr');
            expect(batches[0].locales).not.toContain('es');
        });

        it('should respect the batch size', () => {
            // Mock source files
            const sourceFiles = [
                {
                    path: 'locales/en.json',
                    format: 'json'
                }
            ];

            // Create a large number of keys
            const keys = {};
            for (let i = 0; i < 15; i++) {
                keys[`key${i}`] = `Value ${i}`;
            }

            // Mock missing keys by locale
            const missingByLocale = {
                fr: {
                    path: 'locales/en.json',
                    keys
                }
            };

            // Call the function with a batch size of 5
            const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 5);

            // Verify the result
            expect(errors).toEqual([]);
            expect(batches).toHaveLength(3); // 15 keys / 5 per batch = 3 batches

            // Verify each batch has the correct number of keys
            const batch1Content = JSON.parse(Buffer.from(batches[0].files[0].content, 'base64').toString());
            const batch2Content = JSON.parse(Buffer.from(batches[1].files[0].content, 'base64').toString());
            const batch3Content = JSON.parse(Buffer.from(batches[2].files[0].content, 'base64').toString());

            expect(Object.keys(batch1Content.keys)).toHaveLength(5);
            expect(Object.keys(batch2Content.keys)).toHaveLength(5);
            expect(Object.keys(batch3Content.keys)).toHaveLength(5);
        });
    });
}); 