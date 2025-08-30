import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const fsPromises = fs.promises;

describe('Django Workflow Support', () => {
  let isDjangoWorkflow, getDjangoSourcePath, updateTranslationFile;

  beforeAll(async () => {
    const utilsModule = await import('../../dist/utils/translation-utils.js');
    const updaterModule = await import('../../dist/utils/translation-updater/index.js');
    isDjangoWorkflow = utilsModule.isDjangoWorkflow;
    getDjangoSourcePath = utilsModule.getDjangoSourcePath;
    updateTranslationFile = updaterModule.updateTranslationFile;
  });

  describe('utility functions', () => {
    describe('isDjangoWorkflow', () => {
      it('should return true for django workflow', () => {
        const config = {
          translationFiles: { workflow: 'django' }
        };
        expect(isDjangoWorkflow(config)).toBe(true);
      });

      it('should return false for default workflow', () => {
        const config = {
          translationFiles: { workflow: 'default' }
        };
        expect(isDjangoWorkflow(config)).toBe(false);
      });

      it('should return false when workflow is undefined', () => {
        const config = {
          translationFiles: {}
        };
        expect(isDjangoWorkflow(config)).toBe(false);
      });

      it('should return false when translationFiles is undefined', () => {
        const config = {};
        expect(isDjangoWorkflow(config)).toBe(false);
      });
    });

    describe('getDjangoSourcePath', () => {
      it('should convert main django.po path to sources path', () => {
        const targetPath = 'translations/en/LC_MESSAGES/django.po';
        const expected = 'translations/en/LC_MESSAGES/sources/django-generated.po';
        expect(getDjangoSourcePath(targetPath)).toBe(expected);
      });

      it('should convert main djangojs.po path to sources path', () => {
        const targetPath = 'translations/da/LC_MESSAGES/djangojs.po';
        const expected = 'translations/da/LC_MESSAGES/sources/djangojs-generated.po';
        expect(getDjangoSourcePath(targetPath)).toBe(expected);
      });

      it('should handle nested directory structures', () => {
        const targetPath = 'some/deep/translations/sv/LC_MESSAGES/django.po';
        const expected = 'some/deep/translations/sv/LC_MESSAGES/sources/django-generated.po';
        expect(getDjangoSourcePath(targetPath)).toBe(expected);
      });

      it('should handle paths with different domains', () => {
        const targetPath = 'translations/fi/LC_MESSAGES/custom.po';
        const expected = 'translations/fi/LC_MESSAGES/sources/custom-generated.po';
        expect(getDjangoSourcePath(targetPath)).toBe(expected);
      });
    });
  });

  describe('integration with updateTranslationFile', () => {
    let tempDir, mainFilePath, sourcesFilePath, mockConfig;

    const mockPoContent = `#
msgid ""
msgstr ""

#: test.py
msgid "Hello"
msgstr ""
`;

    beforeEach(async () => {
      tempDir = await fsPromises.mkdtemp(path.join(process.cwd(), 'temp-'));
      mainFilePath = path.join(tempDir, 'translations', 'en', 'LC_MESSAGES', 'django.po');
      sourcesFilePath = path.join(tempDir, 'translations', 'en', 'LC_MESSAGES', 'sources', 'django-generated.po');

      mockConfig = {
        translationFiles: { workflow: 'django' },
        django: { updateSources: true }
      };

      await fsPromises.mkdir(path.dirname(mainFilePath), { recursive: true });
      await fsPromises.mkdir(path.dirname(sourcesFilePath), { recursive: true });
      await fsPromises.writeFile(mainFilePath, mockPoContent);
      await fsPromises.writeFile(sourcesFilePath, mockPoContent);
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    });

    it('should update both main and sources files for Django workflow', async () => {
      const translations = { 'Hello': 'Hej' };

      const result = await updateTranslationFile(mainFilePath, translations, 'en', 'source.po', undefined, mockConfig);

      expect(result.updatedKeys).toEqual(['Hello']);

      const mainContent = await fsPromises.readFile(mainFilePath, 'utf8');
      const sourcesContent = await fsPromises.readFile(sourcesFilePath, 'utf8');

      expect(mainContent).toContain('msgstr "Hej"');
      expect(sourcesContent).toContain('msgstr "Hej"');
    });

    it('should only update main file for non-Django workflow', async () => {
      const regularConfig = { translationFiles: { workflow: 'default' } };
      const translations = { 'Hello': 'Hej' };

      await updateTranslationFile(mainFilePath, translations, 'en', 'source.po', undefined, regularConfig);

      const mainContent = await fsPromises.readFile(mainFilePath, 'utf8');
      const sourcesContent = await fsPromises.readFile(sourcesFilePath, 'utf8');

      expect(mainContent).toContain('msgstr "Hej"');
      expect(sourcesContent).toContain('msgstr ""');
    });
  });

  describe('config integration', () => {
    it('should recognize Django workflow correctly', () => {
      const djangoConfig = {
        translationFiles: { workflow: 'django' },
        django: { updateSources: true }
      };

      expect(isDjangoWorkflow(djangoConfig)).toBe(true);
    });

    it('should not recognize non-Django workflow', () => {
      const defaultConfig = {
        translationFiles: { workflow: 'default' }
      };

      expect(isDjangoWorkflow(defaultConfig)).toBe(false);
    });
  });
});
