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

  describe('batchKeysWithMissing', () => {
    it('should create batches from missing keys', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
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
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);
      expect(errors).toEqual([]);
      expect(batches).toHaveLength(1);
      const batch = batches[0];
      expect(batch.files).toHaveLength(1);
      expect(batch.files[0].path).toBe('locales/en.json');
      expect(batch.files[0].format).toBe('json');
      const content = JSON.parse(Buffer.from(batch.files[0].content, 'base64').toString());
      expect(content.keys).toBeDefined();
      expect(Object.keys(content.keys)).toHaveLength(3);
      expect(content.keys.hello).toBeDefined();
      expect(content.keys.world).toBeDefined();
      expect(content.keys.goodbye).toBeDefined();
      expect(batch.locales).toContain('fr');
      expect(batch.locales).toContain('es');
    });

    it('should handle missing source files', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
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
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 10);
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('missing_source_file');
      expect(errors[0].locale).toBe('es');
      expect(errors[0].path).toBe('locales/non-existent.json');
      expect(batches).toHaveLength(1);
      expect(batches[0].files[0].path).toBe('locales/en.json');
      expect(batches[0].locales).toContain('fr');
      expect(batches[0].locales).not.toContain('es');
    });

    it('should respect the batch size', () => {
      const sourceFiles = [
        {
          path: 'locales/en.json',
          format: 'json'
        }
      ];
      const keys = {};
      for (let i = 0; i < 15; i++) {
        keys[`key${i}`] = `Value ${i}`;
      }
      const missingByLocale = {
        fr: {
          path: 'locales/en.json',
          keys
        }
      };
      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale, 5);
      expect(errors).toEqual([]);
      expect(batches).toHaveLength(3); // 15 keys / 5 per batch = 3 batches
      const batch1Content = JSON.parse(Buffer.from(batches[0].files[0].content, 'base64').toString());
      const batch2Content = JSON.parse(Buffer.from(batches[1].files[0].content, 'base64').toString());
      const batch3Content = JSON.parse(Buffer.from(batches[2].files[0].content, 'base64').toString());

      expect(Object.keys(batch1Content.keys)).toHaveLength(5);
      expect(Object.keys(batch2Content.keys)).toHaveLength(5);
      expect(Object.keys(batch3Content.keys)).toHaveLength(5);
    });

    it('handles boolean values correctly', () => {
      const sourceFiles = [{
        path: 'locales/en.yml',
        format: 'yaml',
        content: Buffer.from('en:\n  app:\n    display_help: true\n    skip_wizard: false').toString('base64')
      }];

      const missingByLocale = {
        fr: {
          path: 'locales/en.yml',
          keys: {
            'app.display_help': true,
            'app.skip_wizard': false
          }
        }
      };

      const { batches, errors } = batchKeysWithMissing(sourceFiles, missingByLocale);

      expect(errors).toHaveLength(0);
      expect(batches).toHaveLength(1);

      const content = JSON.parse(Buffer.from(batches[0].files[0].content, 'base64').toString());
      expect(content.keys['app.display_help'].value).toBe(true);
      expect(content.keys['app.skip_wizard'].value).toBe(false);
      expect(typeof content.keys['app.display_help'].value).toBe('boolean');
      expect(typeof content.keys['app.skip_wizard'].value).toBe('boolean');
    });
  });
});