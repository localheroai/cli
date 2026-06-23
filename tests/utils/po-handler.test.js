import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';

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
    const msgfmtAvailable = spawnSync('msgfmt', ['--version']).status === 0;

    it('preserves PO references, flags, and translator comments when creating a file', async () => {
      const targetFilePath = path.join(tempDir, 'new-with-metadata.po');
      const translations = [
        {
          key: 'Website',
          value: 'Webbplats',
          metadata: {
            source_references: [
              'activity/settings_views.py',
              'chat/settings_views.py',
              'activity/settings_views.py'
            ],
            po_flags: ['elixir-autogen', 'elixir-format', 'elixir-autogen'],
            translator_comments: 'Shown in the site details'
          }
        }
      ];

      const result = await updatePoFile(targetFilePath, translations, 'sv');
      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(result.created).toBe(true);
      expect(updatedContent).toContain('#. Shown in the site details');
      expect(updatedContent).toContain('#: activity/settings_views.py');
      expect(updatedContent).toContain('#: chat/settings_views.py');
      expect(updatedContent).toContain('#, elixir-autogen, elixir-format');
      expect(updatedContent).toContain('msgid "Website"');
      expect(updatedContent).toContain('msgstr "Webbplats"');
      expect(updatedContent.match(/activity\/settings_views\.py/g)).toHaveLength(1);
    });

    it('groups plural forms into one valid entry when creating a file', async () => {
      const targetFilePath = path.join(tempDir, 'new-plural.po');
      const translations = [
        {
          key: 'navigation|%(count)d item',
          value: '%(count)d objekt',
          metadata: {
            po_plural: true,
            plural_index: 0,
            msgid_plural: '%(count)d items',
            source_references: ['lib/cart.ex:10']
          }
        },
        {
          key: 'navigation|%(count)d item__plural_1',
          value: '%(count)d objekt',
          metadata: {
            po_plural: true,
            plural_index: 1,
            msgid: '%(count)d item',
            source_references: ['lib/cart.ex:10']
          }
        }
      ];

      await updatePoFile(targetFilePath, translations, 'sv');
      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain('"Plural-Forms: nplurals=2; plural=(n != 1);\\n"');
      expect(updatedContent).toContain('msgctxt "navigation"');
      expect(updatedContent).toContain('msgid "%(count)d item"');
      expect(updatedContent).toContain('msgid_plural "%(count)d items"');
      expect(updatedContent).toContain('msgstr[0] "%(count)d objekt"');
      expect(updatedContent).toContain('msgstr[1] "%(count)d objekt"');
      expect(updatedContent).not.toContain('msgid "%(count)d item__plural_1"');
      expect(updatedContent.match(/lib\/cart\.ex:10/g)).toHaveLength(1);
      if (msgfmtAvailable) {
        expect(() => execFileSync('msgfmt', ['--check', '-o', '/dev/null', targetFilePath])).not.toThrow();
      }
    });

    it('uses authoritative msgid_plural metadata regardless of input order', async () => {
      const targetFilePath = path.join(tempDir, 'reverse-order-plural.po');
      const translations = [
        {
          key: '%d item__plural_1',
          value: '%d items translated',
          metadata: { po_plural: true, plural_index: 1, msgid: '%d item' }
        },
        {
          key: '%d item',
          value: '%d item translated',
          metadata: { po_plural: true, plural_index: 0, msgid_plural: '%d items' }
        }
      ];

      await updatePoFile(targetFilePath, translations, 'en');
      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain('msgid "%d item"');
      expect(updatedContent).toContain('msgid_plural "%d items"');
      expect(updatedContent).not.toContain('msgid_plural "%d item"');
    });

    it('rejects sparse plural data without msgid_plural metadata', async () => {
      const targetFilePath = path.join(tempDir, 'sparse-plural.po');
      const translations = [{
        key: '%d item__plural_1',
        value: '%d items translated',
        metadata: { po_plural: true, plural_index: 1, msgid: '%d item' }
      }];

      await expect(updatePoFile(targetFilePath, translations, 'en'))
        .rejects
        .toThrow("Cannot create plural PO entry for '%d item' without msgid_plural metadata");
    });

    it.each([
      ['lt', 3, 'nplurals=3'],
      ['ar', 6, 'nplurals=6'],
      ['br', 5, 'nplurals=5']
    ])('writes a valid %s catalog with %i plural forms', async (locale, formCount, header) => {
      const targetFilePath = path.join(tempDir, `new-plural-${locale}.po`);
      const translations = Array.from({ length: formCount }, (_, pluralIndex) => ({
        key: pluralIndex === 0 ? '%d item' : `%d item__plural_${pluralIndex}`,
        value: `%d translated form ${pluralIndex}`,
        metadata: {
          po_plural: true,
          plural_index: pluralIndex,
          ...(pluralIndex === 0
            ? { msgid_plural: '%d items' }
            : { msgid: '%d item' })
        }
      }));

      await updatePoFile(targetFilePath, translations, locale);
      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain(header);
      expect(updatedContent.match(/msgstr\[\d+\]/g)).toHaveLength(formCount);
      if (msgfmtAvailable) {
        expect(() => execFileSync('msgfmt', ['--check', '-o', '/dev/null', targetFilePath])).not.toThrow();
      }
    });

    it.each([
      ['fr-CA', 'nplurals=2; plural=(n > 1);'],
      ['is', 'nplurals=2; plural=(n%10!=1 || n%100==11);'],
      ['mk', 'nplurals=2; plural=(n==1 || n%10==1 ? 0 : 1);']
    ])('uses the locale-specific plural rule for %s', async (locale, header) => {
      const targetFilePath = path.join(tempDir, `specific-plural-${locale}.po`);
      const translations = [0, 1].map(pluralIndex => ({
        key: pluralIndex === 0 ? '%d item' : '%d item__plural_1',
        value: `%d translated form ${pluralIndex}`,
        metadata: {
          po_plural: true,
          plural_index: pluralIndex,
          ...(pluralIndex === 0
            ? { msgid_plural: '%d items' }
            : { msgid: '%d item' })
        }
      }));

      await updatePoFile(targetFilePath, translations, locale);
      const updatedContent = await fs.readFile(targetFilePath, 'utf-8');

      expect(updatedContent).toContain(header);
    });

    it('refuses to invent a plural rule for an unsupported locale', async () => {
      const targetFilePath = path.join(tempDir, 'unsupported-plural.po');
      const translations = [
        {
          key: '%d item',
          value: '%d first form',
          metadata: { po_plural: true, plural_index: 0, msgid_plural: '%d items' }
        },
        {
          key: '%d item__plural_1',
          value: '%d second form',
          metadata: { po_plural: true, plural_index: 1, msgid: '%d item' }
        }
      ];

      await expect(updatePoFile(targetFilePath, translations, 'xx'))
        .rejects
        .toThrow("Cannot create plural PO file for unsupported locale 'xx'");
    });

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
