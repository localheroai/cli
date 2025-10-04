import { describe, it, expect, jest } from '@jest/globals';
import { findMissingTranslations, batchKeysWithMissing, generateTargetPath, findMissingTranslationsByLocale, processLocaleTranslations } from '../../src/utils/translation-utils.js';
import { findMissingPoTranslations, createUniqueKey } from '../../src/utils/po-utils.js';

const createBase64Content = (data) => Buffer.from(JSON.stringify(data)).toString('base64');

const createConfig = (sourceLocale = 'en', outputLocales = ['fr', 'es']) => ({
  sourceLocale,
  outputLocales
});

const createJsonFile = (path, content, locale = null) => ({
  path,
  format: 'json',
  content: createBase64Content(content),
  ...(locale && { locale })
});

const createMockLogger = () => ({ log: jest.fn() });

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

    it.each([
      ['wip_ prefix', 'wip_feature', 'wip_This is a work in progress'],
      ['_wip suffix', 'feature', 'This is a work in progress_wip'],
      ['__skip_translation__ marker', 'skip_me', '__skip_translation__']
    ])('should skip WIP keys with %s', (_, key, value) => {
      const sourceKeys = {
        hello: { value: 'Hello' },
        [key]: { value }
      };

      const targetKeys = {
        hello: { value: 'Hola' }
      };

      const result = findMissingTranslations(sourceKeys, targetKeys);
      expect(result.missingKeys).toEqual({});
      expect(result.skippedKeys).toEqual({
        [key]: {
          value,
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
          content: createBase64Content({
            welcome: 'Welcome',
            goodbye: 'Goodbye',
            hello: 'Hello'
          })
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: createBase64Content({
              welcome: 'Bienvenue',
              // Missing 'goodbye' and 'hello'
            }),
            locale: 'fr'
          }
        ],
        es: [
          {
            path: 'locales/es.json',
            format: 'json',
            content: createBase64Content({
              welcome: 'Bienvenido',
              hello: 'Hola'
              // Missing 'goodbye'
            }),
            locale: 'es'
          }
        ]
      };

      const config = createConfig('en', ['fr', 'es']);

      const mockLogger = createMockLogger();

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
          content: createBase64Content({
            en: {
              welcome: 'Welcome',
              goodbye: 'Goodbye'
            }
          })
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: createBase64Content({
              fr: {
                welcome: 'Bienvenue'
                // Missing 'goodbye'
              }
            }),
            locale: 'fr'
          }
        ]
      };

      const config = createConfig('en', ['fr']);

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
          content: createBase64Content({
            welcome: 'Welcome'
          })
        }
      ];

      const targetFilesByLocale = {
        fr: [
          {
            path: 'locales/fr.json',
            format: 'json',
            content: createBase64Content({}),
            locale: 'fr'
          }
        ]
      };

      const config = createConfig('en', ['fr']);

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
      for (let i = 1; i <= 450; i++) {
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
      expect(batchSizes[0]).toBe(200);
      expect(batchSizes[1]).toBe(200);
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
      expect(allKeys.size).toBe(450);
    });
  });

  describe('generateTargetPath', () => {
    it.each([
      ['simple locale replacement', 'config/locales/en.yml', 'config/locales/es.yml'],
      ['locale in filename with dot', 'config/locales/translations.en.yml', 'config/locales/translations.es.yml'],
      ['locale in filename with hyphen', 'config/locales/translations-en.yml', 'config/locales/translations-es.yml'],
      ['locale in directory name', 'config/locales/en/messages.yml', 'config/locales/es/messages.yml'],
      ['prevents double dots in filenames', 'config/en/translations.en.yml', 'config/en/translations.es.yml']
    ])('handles %s', (_, sourcePath, expectedPath) => {
      const sourceFile = { path: sourcePath };
      expect(generateTargetPath(sourceFile, 'es', 'en')).toBe(expectedPath);
    });
  });

  describe('PO context prefix bug regression tests', () => {
    // These tests prevent regression of bugs where context prefixes were incorrectly handled
    // Bug 1: Plural + context keys were double-prefixed (e.g., "context|context|msgid")
    // Bug 2: Non-plural + context keys lost their context prefix

    const createTranslationFile = (content, locale = 'sv', path = `translations/${locale}/LC_MESSAGES/django.po`) => ({
      path,
      locale,
      format: 'po',
      content: Buffer.from(content).toString('base64')
    });
    const PO_HEADER = 'msgid ""\nmsgstr ""\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n';
    const buildPoEntry = (msgid, msgstr = '""', msgctxt = null, msgidPlural = null) => {
      const parts = [];
      if (msgctxt) parts.push(`msgctxt "${msgctxt}"`);
      parts.push(`msgid "${msgid}"`);
      if (msgidPlural) parts.push(`msgid_plural "${msgidPlural}"`);

      if (Array.isArray(msgstr)) {
        msgstr.forEach((str, idx) => parts.push(`msgstr[${idx}] ${str}`));
      } else {
        parts.push(`msgstr ${msgstr}`);
      }

      return parts.join('\n');
    };
    const buildPoContent = (...entries) => PO_HEADER + '\n' + entries.join('\n\n');

    it('should correctly prefix non-plural entries with context', () => {
      // This test prevents Bug 2: non-plural + context keys losing their prefix

      const content = buildPoContent(
        buildPoEntry('Warning: This action cannot be undone', '""', 'warning-message')
      );

      const sourceFile = createTranslationFile(content, 'sv');
      const targetFile = createTranslationFile(content, 'en');

      const result = processLocaleTranslations(
        {},
        'en',
        [targetFile],
        sourceFile,
        'sv'
      );

      expect(Object.keys(result.missingKeys)).toHaveLength(1);
      expect(result.missingKeys['warning-message|Warning: This action cannot be undone']).toBeDefined();
      expect(result.missingKeys['Warning: This action cannot be undone']).toBeUndefined();
    });

    it('should not double-prefix plural entries with context', () => {
      // This test prevents Bug 1: plural + context keys being double-prefixed

      const content = buildPoContent(
        buildPoEntry('Updated %(counter)s day ago', ['""', '""'], 'time-period', 'Updated %(counter)s days ago')
      );
      const sourceFile = createTranslationFile(content, 'sv');
      const targetFile = createTranslationFile(content, 'en');

      const result = processLocaleTranslations(
        {},
        'en',
        [targetFile],
        sourceFile,
        'sv'
      );

      expect(Object.keys(result.missingKeys)).toHaveLength(2);
      expect(result.missingKeys['time-period|Updated %(counter)s day ago']).toBeDefined();
      expect(result.missingKeys['time-period|Updated %(counter)s day ago__plural_1']).toBeDefined();
      expect(result.missingKeys['time-period|time-period|Updated %(counter)s day ago']).toBeUndefined();
      expect(result.missingKeys['time-period|time-period|Updated %(counter)s day ago__plural_1']).toBeUndefined();
    });

    it('should handle mixed plural and non-plural entries with context', () => {
      const content = buildPoContent(
        buildPoEntry('Warning: Cannot undo', '""', 'warning-message'),
        buildPoEntry('%(count)s day', ['""', '""'], 'time-period', '%(count)s days'),
        buildPoEntry('Save', '""', 'button-label')
      );
      const sourceFile = createTranslationFile(content, 'sv');
      const targetFile = createTranslationFile(content, 'en');
      const result = processLocaleTranslations(
        {},
        'en',
        [targetFile],
        sourceFile,
        'sv'
      );

      expect(Object.keys(result.missingKeys)).toHaveLength(4);
      expect(result.missingKeys['warning-message|Warning: Cannot undo']).toBeDefined();
      expect(result.missingKeys['time-period|%(count)s day']).toBeDefined();
      expect(result.missingKeys['time-period|%(count)s day__plural_1']).toBeDefined();
      expect(result.missingKeys['button-label|Save']).toBeDefined();
      expect(result.missingKeys['warning-message|warning-message|Warning: Cannot undo']).toBeUndefined();
      expect(result.missingKeys['time-period|time-period|%(count)s day']).toBeUndefined();
      expect(result.missingKeys['Warning: Cannot undo']).toBeUndefined();
      expect(result.missingKeys['Save']).toBeUndefined();
    });
  });
});
