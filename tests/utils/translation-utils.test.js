import { describe, it, expect, jest } from '@jest/globals';
import { findMissingTranslations, batchKeysWithMissing, generateTargetPath, findMissingTranslationsByLocale } from '../../src/utils/translation-utils.js';

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

    it('should handle boolean values correctly', () => {
      const sourceKeys = {
        'app.utils.show_wizard': true,
        'app.utils.skip_wizard': false,
        'app.utils.display_help': { value: true }
      };

      const targetKeys = {};

      const result = findMissingTranslations(sourceKeys, targetKeys);

      expect(result.missingKeys).toEqual({
        'app.utils.show_wizard': {
          value: true,
          sourceKey: 'app.utils.show_wizard'
        },
        'app.utils.skip_wizard': {
          value: false,
          sourceKey: 'app.utils.skip_wizard'
        },
        'app.utils.display_help': {
          value: true,
          sourceKey: 'app.utils.display_help'
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

  describe('findMissingTranslationsByLocale', () => {
    it('should find missing translations for multiple locales', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            welcome: 'Welcome',
            goodbye: 'Goodbye',
            hello: 'Hello'
          })).toString('base64')
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              welcome: 'Bienvenue',
              // Missing 'goodbye' and 'hello'
            })).toString('base64'),
            locale: 'fr'
          }
        ],
        es: [
          {
            path: 'locales/es.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              welcome: 'Bienvenido',
              hello: 'Hola'
              // Missing 'goodbye'
            })).toString('base64'),
            locale: 'es'
          }
        ]
      };

      const config = {
        sourceLocale: 'en',
        outputLocales: ['fr', 'es']
      };

      const mockLogger = {
        log: jest.fn()
      };

      const result = findMissingTranslationsByLocale(
        sourceFiles,
        targetFilesByLocale,
        config,
        false,
        mockLogger
      );

      // Check French missing translations
      expect(result['fr:locales/en.json']).toBeDefined();
      expect(result['fr:locales/en.json'].locale).toBe('fr');
      expect(result['fr:locales/en.json'].path).toBe('locales/en.json');
      expect(result['fr:locales/en.json'].targetPath).toBe('locales/fr.json');
      expect(Object.keys(result['fr:locales/en.json'].keys)).toContain('goodbye');
      expect(Object.keys(result['fr:locales/en.json'].keys)).toContain('hello');
      expect(Object.keys(result['fr:locales/en.json'].keys)).not.toContain('welcome');

      // Check Spanish missing translations
      expect(result['es:locales/en.json']).toBeDefined();
      expect(result['es:locales/en.json'].locale).toBe('es');
      expect(result['es:locales/en.json'].path).toBe('locales/en.json');
      expect(result['es:locales/en.json'].targetPath).toBe('locales/es.json');
      expect(Object.keys(result['es:locales/en.json'].keys)).toContain('goodbye');
      expect(Object.keys(result['es:locales/en.json'].keys)).not.toContain('hello');
      expect(Object.keys(result['es:locales/en.json'].keys)).not.toContain('welcome');
    });

    it('should handle source files with nested locale structure', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            en: {
              welcome: 'Welcome',
              goodbye: 'Goodbye'
            }
          })).toString('base64')
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              fr: {
                welcome: 'Bienvenue'
                // Missing 'goodbye'
              }
            })).toString('base64'),
            locale: 'fr'
          }
        ]
      };

      const config = {
        sourceLocale: 'en',
        outputLocales: ['fr']
      };

      const result = findMissingTranslationsByLocale(
        sourceFiles,
        targetFilesByLocale,
        config,
        false
      );

      expect(result['fr:locales/en.json']).toBeDefined();
      expect(result['fr:locales/en.json'].locale).toBe('fr');
      expect(Object.keys(result['fr:locales/en.json'].keys)).toContain('goodbye');
      expect(Object.keys(result['fr:locales/en.json'].keys)).not.toContain('welcome');
    });

    it('should skip files with work-in-progress keys and log them in verbose mode', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            welcome: 'Welcome',
            wip_feature: 'wip_This is a work in progress',
            skip_this: '__skip_translation__'
          })).toString('base64')
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({
              welcome: 'Bienvenue'
            })).toString('base64'),
            locale: 'fr'
          }
        ]
      };

      const config = {
        sourceLocale: 'en',
        outputLocales: ['fr']
      };

      const mockLogger = {
        log: jest.fn()
      };

      const result = findMissingTranslationsByLocale(
        sourceFiles,
        targetFilesByLocale,
        config,
        true, // verbose enabled
        mockLogger
      );

      // No missing keys that aren't skipped
      expect(Object.keys(result)).toHaveLength(0);

      // Should have logged skipped keys
      expect(mockLogger.log).toHaveBeenCalled();
      const logCall = mockLogger.log.mock.calls[0][0];
      expect(logCall).toContain('Skipped');
      expect(logCall).toContain('WIP');
    });

    it('should handle source files with invalid or missing content', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json',
          // Missing content
        },
        {
          path: 'locales/en2.json',
          format: 'json',
          content: Buffer.from(JSON.stringify({
            welcome: 'Welcome'
          })).toString('base64')
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: Buffer.from(JSON.stringify({})).toString('base64'),
            locale: 'fr'
          }
        ]
      };

      const config = {
        sourceLocale: 'en',
        outputLocales: ['fr']
      };

      const result = findMissingTranslationsByLocale(
        sourceFiles,
        targetFilesByLocale,
        config,
        false
      );

      // Should skip file with missing content, still process valid file
      expect(result['fr:locales/en.json']).toBeUndefined();
      expect(result['fr:locales/en2.json']).toBeDefined();
      expect(result['fr:locales/en2.json'].keys.welcome).toBeDefined();
    });
  });

  describe('batchKeysWithMissing', () => {
    it('should create batches from missing keys', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: {
            'hello': 'Hello',
            'world': 'World'
          }
        },
        'es:locales/en.json': {
          locale: 'es',
          path: 'locales/en.json',
          targetPath: 'locales/es.json',
          keys: {
            'hello': 'Hello',
            'goodbye': 'Goodbye'
          }
        }
      };
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);
      expect(errors).toEqual([]);
      expect(batches).toHaveLength(1);
      const batch = batches[0];
      expect(batch.sourceFilePath).toBe('locales/en.json');
      expect(batch.sourceFile.path).toBe('locales/en.json');
      expect(batch.sourceFile.format).toBe('json');
      const content = JSON.parse(Buffer.from(batch.sourceFile.content, 'base64').toString());
      expect(content.keys).toBeDefined();
      expect(Object.keys(content.keys)).toHaveLength(3);
      expect(content.keys.hello).toBeDefined();
      expect(content.keys.world).toBeDefined();
      expect(content.keys.goodbye).toBeDefined();
      expect(batch.locales).toContain('fr');
      expect(batch.locales).toContain('es');
      expect(batch.localeEntries).toContain('fr:locales/en.json');
      expect(batch.localeEntries).toContain('es:locales/en.json');
    });

    it('should handle missing source files', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: {
            'hello': 'Hello'
          }
        },
        'es:locales/non-existent.json': {
          locale: 'es',
          path: 'locales/non-existent.json',
          targetPath: 'locales/es.json',
          keys: {
            'hello': 'Hello'
          }
        }
      };
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('missing_source_file');
      expect(errors[0].path).toBe('locales/non-existent.json');
      expect(batches).toHaveLength(1);
      expect(batches[0].sourceFile.path).toBe('locales/en.json');
      expect(batches[0].locales).toContain('fr');
      expect(batches[0].locales).not.toContain('es');
      expect(batches[0].localeEntries).toContain('fr:locales/en.json');
      expect(batches[0].localeEntries).not.toContain('es:locales/non-existent.json');
    });

    it('should handle complex values', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: {
            'array': ['one', 'two'],
            'boolean': true,
            'object': { value: 'test' },
            'complex': { nested: { deep: 'value' } }
          }
        }
      };
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale);
      expect(errors).toEqual([]);
      expect(batches).toHaveLength(1);
      const content = JSON.parse(Buffer.from(batches[0].sourceFile.content, 'base64').toString());
      expect(content.keys.array.value).toEqual(['one', 'two']);
      expect(content.keys.boolean.value).toBe(true);
      expect(content.keys.object.value).toBe('test');
      expect(content.keys.complex.value).toBe('{"nested":{"deep":"value"}}');
    });

    it('splits large batches into chunks of max 100 items', async () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];

      const missingKeys = {};
      for (let i = 1; i <= 250; i++) {
        missingKeys[`key${i}`] = `Value ${i}`;
      }

      const missingByLocale = {
        'fr:locales/en.json': {
          locale: 'fr',
          path: 'locales/en.json',
          targetPath: 'locales/fr.json',
          keys: missingKeys
        }
      };

      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale);

      expect(errors).toEqual([]);
      expect(batches).toHaveLength(3);

      const batchSizes = batches.map(batch =>
        Object.keys(JSON.parse(Buffer.from(batch.sourceFile.content, 'base64').toString()).keys).length
      );
      expect(batchSizes[0]).toBe(100);
      expect(batchSizes[1]).toBe(100);
      expect(batchSizes[2]).toBe(50);

      batches.forEach(batch => {
        expect(batch.sourceFilePath).toBe('locales/en.json');
        expect(batch.sourceFile.format).toBe('json');
        expect(batch.locales).toEqual(['fr']);
        expect(batch.localeEntries).toEqual(['fr:locales/en.json']);
      });

      const allKeys = new Set();
      batches.forEach(batch => {
        const content = JSON.parse(Buffer.from(batch.sourceFile.content, 'base64').toString());
        Object.keys(content.keys).forEach(key => allKeys.add(key));
      });
      expect(allKeys.size).toBe(250);
    });
  });

  describe('generateTargetPath', () => {
    it('handles simple locale replacement', () => {
      const sourceFile = { path: 'config/locales/en.yml' };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe('config/locales/es.yml');
    });

    it('handles locale in filename with dot', () => {
      const sourceFile = { path: 'config/locales/translations.en.yml' };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe('config/locales/translations.es.yml');
    });

    it('handles locale in filename with hyphen', () => {
      const sourceFile = { path: 'config/locales/translations-en.yml' };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe('config/locales/translations-es.yml');
    });

    it('handles locale in directory name', () => {
      const sourceFile = { path: 'config/locales/en/messages.yml' };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe('config/locales/es/messages.yml');
    });

    it('prevents double dots in filenames', () => {
      const sourceFile = { path: 'config/en/translations.en.yml' };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe('config/en/translations.es.yml');
    });
  });
});