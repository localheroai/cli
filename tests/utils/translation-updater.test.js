import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile, deleteKeysFromTranslationFile } from '../../src/utils/translation-updater.js';

describe('translation-updater', () => {
  let tempDir;
  let originalConsole;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-test-'));

    originalConsole = { ...console };
    global.console = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: originalConsole.info
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    global.console = originalConsole;
  });

  describe('updateTranslationFile', () => {
    it('preserves existing quote styles in YAML files', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      const initialContent = `
en:
  greeting: "Hello, %{name}!"
  message: 'Welcome'
  plain: text
`;
      fs.writeFileSync(filePath, initialContent);

      await updateTranslationFile(filePath, {
        'greeting': 'Hi, %{name}!',
        'message': 'Hello',
        'plain': 'simple'
      });

      const updatedContent = fs.readFileSync(filePath, 'utf8');
      expect(updatedContent).toContain('greeting: "Hi, %{name}!"');
      expect(updatedContent).toContain("message: 'Hello'");
      expect(updatedContent).toContain('plain: simple');
    });

    it('adds quotes for values with special characters', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      await updateTranslationFile(filePath, {
        'special': 'Contains: special, characters!',
        'normal': 'plain text'
      });

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('special: "Contains: special, characters!"');
      expect(content).toContain('normal: plain text');
    });

    it('handles nested structures correctly', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      await updateTranslationFile(filePath, {
        'buttons.submit': 'Submit',
        'buttons.cancel': 'Cancel',
        'messages.welcome': 'Welcome'
      });

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toMatch(/buttons:\n\s+submit: Submit\n\s+cancel: Cancel/);
      expect(content).toMatch(/messages:\n\s+welcome: Welcome/);
    });

    it('preserves existing content structure', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      const initialContent = `
en:
  buttons:
    submit: "Submit"
  messages:
    welcome: Welcome
`;
      fs.writeFileSync(filePath, initialContent);

      await updateTranslationFile(filePath, {
        'buttons.cancel': 'Cancel',
        'messages.goodbye': 'Goodbye'
      });

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('submit: "Submit"');
      expect(content).toMatch(/buttons:\n\s+submit: "Submit"\n\s+cancel: Cancel/);
      expect(content).toMatch(/messages:\n\s+welcome: Welcome\n\s+goodbye: Goodbye/);
    });

    it('handles errors gracefully', async () => {
      const filePath = path.join(tempDir, 'nonexistent', 'en.yml');
      const updates = { 'key': 'value' };

      const result = await updateTranslationFile(filePath, updates);
      expect(result).toEqual({
        updatedKeys: ['key'],
        created: true
      });
    });

    it('handles JSON files with existing content', async () => {
      const filePath = path.join(tempDir, 'translations.json');

      const initialContent = {
        navbar: {
          home: 'Old Home'
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));

      const translations = {
        'navbar.home': 'Home',
        'navbar.about': 'About'
      };

      const result = await updateTranslationFile(filePath, translations, 'en');

      expect(result).toEqual({
        updatedKeys: ['navbar.home', 'navbar.about'],
        created: false
      });

      const updatedContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(updatedContent).toEqual({
        navbar: {
          home: 'Home',
          about: 'About'
        }
      });
    });

    it('creates new JSON file if it does not exist', async () => {
      const filePath = path.join(tempDir, 'new-translations.json');
      const translations = {
        'navbar.home': 'Home'
      };

      const result = await updateTranslationFile(filePath, translations, 'en');

      expect(result).toEqual({
        updatedKeys: ['navbar.home'],
        created: true
      });

      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(fileContent).toEqual({
        navbar: {
          home: 'Home'
        }
      });
    });
  });

  describe('deleteKeysFromTranslationFile', () => {
    it('deletes keys from JSON file', async () => {
      const filePath = path.join(tempDir, 'en.json');
      const initialContent = {
        greeting: 'Hello',
        buttons: {
          submit: 'Submit',
          cancel: 'Cancel'
        },
        deprecated: {
          feature: 'Old Feature',
          other: 'Other Feature'
        }
      };

      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));

      await deleteKeysFromTranslationFile(filePath, ['deprecated.feature']);

      const updatedContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(updatedContent).toHaveProperty('greeting');
      expect(updatedContent).toHaveProperty('buttons.submit');
      expect(updatedContent).toHaveProperty('buttons.cancel');
      expect(updatedContent).not.toHaveProperty('deprecated.feature');

      expect(updatedContent).toHaveProperty('deprecated');
      expect(updatedContent.deprecated).toHaveProperty('other');
    });

    it('deletes keys from YAML file', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      const initialContent = `
en:
  greeting: "Hello"
  buttons:
    submit: "Submit"
    cancel: "Cancel"
  deprecated:
    feature: "Old Feature"
    other: "Other Feature"
`;
      fs.writeFileSync(filePath, initialContent);

      await deleteKeysFromTranslationFile(filePath, ['deprecated.feature']);

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('greeting: "Hello"');
      expect(content).toContain('submit: "Submit"');
      expect(content).not.toContain('feature: "Old Feature"');
      expect(content).toContain('other: "Other Feature"');
    });

    it('deletes entire parent object when all children are deleted', async () => {
      const filePath = path.join(tempDir, 'en.json');
      const initialContent = {
        greeting: 'Hello',
        deprecated: {
          feature: 'Old Feature'
        }
      };

      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));

      await deleteKeysFromTranslationFile(filePath, ['deprecated.feature']);

      const updatedContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(updatedContent).toHaveProperty('greeting');

      expect(updatedContent).not.toHaveProperty('deprecated');
    });

    it('handles files with language wrapper', async () => {
      const filePath = path.join(tempDir, 'en.json');
      const initialContent = {
        en: {
          greeting: 'Hello',
          deprecated: {
            feature: 'Old Feature'
          }
        }
      };

      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));

      await deleteKeysFromTranslationFile(filePath, ['deprecated.feature'], 'en');

      const updatedContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(updatedContent.en).toHaveProperty('greeting');
      expect(updatedContent.en).not.toHaveProperty('deprecated');
    });

    it('handles non-existent keys gracefully', async () => {
      const filePath = path.join(tempDir, 'en.json');
      const initialContent = {
        greeting: 'Hello'
      };

      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));

      await deleteKeysFromTranslationFile(filePath, ['nonexistent.key']);

      const updatedContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(updatedContent).toEqual(initialContent);
    });

    it('handles non-existent files gracefully', async () => {
      const filePath = path.join(tempDir, 'nonexistent.json');

      await expect(deleteKeysFromTranslationFile(filePath, ['some.key']))
        .resolves
        .toEqual([]);
    });
  });
});