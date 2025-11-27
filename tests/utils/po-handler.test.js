import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('po-handler', () => {
  let updatePoFile;
  let deleteKeysFromPoFile;
  let tempDir;

  beforeEach(async () => {
    jest.resetModules();

    const poHandler = await import('../../src/utils/translation-updater/po-handler.js');
    updatePoFile = poHandler.updatePoFile;
    deleteKeysFromPoFile = poHandler.deleteKeysFromPoFile;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'po-handler-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rmdir(tempDir, { recursive: true });
    }
  });

  describe('updatePoFile', () => {
    it('preserves Language header from source file', async () => {
      const sourceFilePath = path.join(tempDir, 'source.po');
      const sourceContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: \\n"
"MIME-Version: 1.0\\n"

#: app/views.py
msgid "hello"
msgstr "Hello"
`;
      await fs.writeFile(sourceFilePath, sourceContent);

      // Create target file by copying from source
      const targetFilePath = path.join(tempDir, 'target.po');
      const translations = {
        'hello': 'Hej'
      };

      const result = await updatePoFile(targetFilePath, translations, 'sv', sourceFilePath);

      expect(result.created).toBe(true);

      const targetContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(targetContent).toContain('"Language: \\n"');
      expect(targetContent).not.toContain('"Language: sv\\n"');
      expect(targetContent).toContain('msgstr "Hej"');
    });

    it('preserves Language header with value from source file', async () => {
      const sourceFilePath = path.join(tempDir, 'source.po');
      const sourceContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: en\\n"
"MIME-Version: 1.0\\n"

#: app/views.py
msgid "hello"
msgstr "Hello"
`;
      await fs.writeFile(sourceFilePath, sourceContent);

      const targetFilePath = path.join(tempDir, 'target.po');
      const translations = { 'hello': 'Bonjour' };

      await updatePoFile(targetFilePath, translations, 'fr', sourceFilePath);

      const targetContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(targetContent).toContain('"Language: en\\n"');
      expect(targetContent).not.toContain('"Language: fr\\n"');
    });

    it('updates existing file without modifying headers', async () => {
      const targetFilePath = path.join(tempDir, 'existing.po');
      const existingContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: \\n"
"Project-Id-Version: MyProject\\n"

#: app/views.py
msgid "hello"
msgstr "Old translation"
`;
      await fs.writeFile(targetFilePath, existingContent);

      const translations = { 'hello': 'New translation' };

      const result = await updatePoFile(targetFilePath, translations, 'sv');

      expect(result.created).toBe(false);

      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain('"Language: \\n"');
      expect(updatedContent).toContain('"Project-Id-Version: MyProject\\n"');
      expect(updatedContent).toContain('msgstr "New translation"');
    });
  });

  describe('deleteKeysFromPoFile', () => {
    it('handles non-existent file gracefully', async () => {
      const nonExistentPath = path.join(tempDir, 'non-existent.po');

      await expect(deleteKeysFromPoFile(nonExistentPath, ['hello'])).resolves.toBeUndefined();
    });
  });

  describe('SyncTranslation array support', () => {
    it('should accept array of translations with metadata', async () => {
      const targetFilePath = path.join(tempDir, 'array-test.po');
      const existingContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "Hello"
`;
      await fs.writeFile(targetFilePath, existingContent);

      const translations = [
        { key: 'Hello', value: 'Hej' },
        { key: 'Goodbye', value: 'Hej då' }
      ];

      const result = await updatePoFile(targetFilePath, translations, 'sv');

      expect(result.created).toBe(false);
      expect(result.updatedKeys).toContain('Hello');
      expect(result.updatedKeys).toContain('Goodbye');

      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');
      expect(updatedContent).toContain('msgstr "Hej"');
      expect(updatedContent).toContain('msgstr "Hej då"');
    });

    it('should handle old_values for PO key versioning', async () => {
      const targetFilePath = path.join(tempDir, 'versioning-test.po');
      const existingContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Redigera objekt"
msgstr "Edit item"
`;
      await fs.writeFile(targetFilePath, existingContent);

      const translations = [
        {
          key: 'Ändra objekt',
          value: 'Modify item',
          old_values: [{ key: 'Redigera objekt' }]
        }
      ];

      const result = await updatePoFile(targetFilePath, translations, 'en');

      expect(result.created).toBe(false);

      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain('msgid "Ändra objekt"');
      expect(updatedContent).not.toContain('msgid "Redigera objekt"');
      expect(updatedContent).toContain('msgstr "Modify item"');
    });

    it('should handle mixed array (with and without old_values)', async () => {
      const targetFilePath = path.join(tempDir, 'mixed-test.po');
      const existingContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Old key"
msgstr "Old value"

msgid "Regular key"
msgstr "Regular value"
`;
      await fs.writeFile(targetFilePath, existingContent);

      const translations = [
        {
          key: 'New key',
          value: 'New value',
          old_values: [{ key: 'Old key' }]
        },
        {
          key: 'Regular key',
          value: 'Updated regular value'
        },
        {
          key: 'Brand new key',
          value: 'Brand new value'
        }
      ];

      const result = await updatePoFile(targetFilePath, translations, 'en');

      expect(result.created).toBe(false);

      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain('msgid "New key"');
      expect(updatedContent).not.toContain('msgid "Old key"');
      expect(updatedContent).toContain('msgstr "New value"');
      expect(updatedContent).toContain('msgid "Regular key"');
      expect(updatedContent).toContain('msgstr "Updated regular value"');
      expect(updatedContent).toContain('msgid "Brand new key"');
      expect(updatedContent).toContain('msgstr "Brand new value"');
    });
  });
});
