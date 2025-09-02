import { jest } from '@jest/globals';

describe('po-utils', () => {
  let parsePoFile;
  let createUniqueKey;
  let parseUniqueKey;
  let poEntriesToApiFormat;
  let findMissingPoTranslations;
  let updatePoFile;
  let createPoFile;

  beforeEach(async () => {
    jest.resetModules();

    const poUtilsModule = await import('../../src/utils/po-utils.js');
    parsePoFile = poUtilsModule.parsePoFile;
    createUniqueKey = poUtilsModule.createUniqueKey;
    parseUniqueKey = poUtilsModule.parseUniqueKey;
    poEntriesToApiFormat = poUtilsModule.poEntriesToApiFormat;
    findMissingPoTranslations = poUtilsModule.findMissingPoTranslations;
    updatePoFile = poUtilsModule.updatePoFile;
    createPoFile = poUtilsModule.createPoFile;
  });

  describe('createUniqueKey', () => {
    it('should create key without context', () => {
      const result = createUniqueKey('Hello');
      expect(result).toBe('Hello');
    });

    it('should create key with context using pipe separator', () => {
      const result = createUniqueKey('May', 'ShortenedMonths');
      expect(result).toBe('ShortenedMonths|May');
    });
  });

  describe('parseUniqueKey', () => {
    it('should parse key without context', () => {
      const result = parseUniqueKey('Hello');
      expect(result).toEqual({ msgid: 'Hello' });
    });

    it('should parse key with context', () => {
      const result = parseUniqueKey('ShortenedMonths|May');
      expect(result).toEqual({
        context: 'ShortenedMonths',
        msgid: 'May'
      });
    });

    it('should handle msgid with pipe characters', () => {
      const result = parseUniqueKey('ShortenedMonths|This|has|pipes');
      expect(result).toEqual({
        context: 'ShortenedMonths',
        msgid: 'This|has|pipes'
      });
    });
  });

  describe('parsePoFile', () => {
    it('should parse basic .po file', () => {
      const poContent = `# Test .po file
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "Hello"

msgid "Goodbye"
msgstr "Goodbye"
`;

      const result = parsePoFile(poContent);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        msgid: 'Hello',
        msgstr: ['Hello'],
        msgctxt: undefined,
        msgid_plural: undefined,
        comments: undefined
      });
    });

    it('should parse .po file with context', () => {
      const poContent = `# Test .po file with context
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgctxt "ShortenedMonths"
msgid "May"
msgstr "Mai"
`;

      const result = parsePoFile(poContent);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        msgid: 'May',
        msgstr: ['Mai'],
        msgctxt: 'ShortenedMonths',
        msgid_plural: undefined,
        comments: undefined
      });
    });

    it('should parse .po file with plurals', () => {
      const poContent = `# Test .po file with plurals
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "%(count)d item"
msgid_plural "%(count)d items"
msgstr[0] "%(count)d item"
msgstr[1] "%(count)d items"
`;

      const result = parsePoFile(poContent);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        msgid: '%(count)d item',
        msgstr: ['%(count)d item', '%(count)d items'],
        msgctxt: undefined,
        msgid_plural: '%(count)d items',
        comments: undefined
      });
    });
  });

  describe('poEntriesToApiFormat', () => {
    it('should convert simple entries to API format', () => {
      const entries = [
        {
          msgid: 'Hello',
          msgstr: ['Hello'],
          msgctxt: undefined,
          msgid_plural: undefined,
          comments: undefined
        },
        {
          msgid: 'May',
          msgstr: ['Mai'],
          msgctxt: 'ShortenedMonths',
          msgid_plural: undefined,
          comments: undefined
        }
      ];

      const result = poEntriesToApiFormat(entries);

      expect(result).toEqual({
        'Hello': {
          value: 'Hello'
        },
        'ShortenedMonths|May': {
          value: 'Mai',
          context: 'ShortenedMonths'
        }
      });
    });

    it('should convert entries with metadata to API format', () => {
      const entries = [
        {
          msgid: 'Hello',
          msgstr: ['Hej'],
          msgctxt: undefined,
          msgid_plural: undefined,
          comments: {
            extracted: 'Translators: hello_greeting'
          }
        }
      ];

      const result = poEntriesToApiFormat(entries);

      expect(result['Hello']).toEqual({
        value: 'Hej',
        metadata: 'hello_greeting'
      });
    });

    it('should convert plural entries to two linked keys', () => {
      const entries = [
        {
          msgid: '%(count)s mail',
          msgstr: ['%(count)s e-post', '%(count)s e-poster'],
          msgctxt: undefined,
          msgid_plural: '%(count)s mails',
          comments: undefined
        }
      ];

      const result = poEntriesToApiFormat(entries);

      // Should create two linked keys
      expect(Object.keys(result)).toHaveLength(2);

      // Singular form
      expect(result['%(count)s mail']).toEqual({
        value: '%(count)s e-post',
        metadata: {
          po_plural: true,
          msgid_plural: '%(count)s mails',
          plural_index: 0
        }
      });

      // Plural form with special suffix
      expect(result['%(count)s mail__plural_1']).toEqual({
        value: '%(count)s e-poster',
        metadata: {
          po_plural: true,
          msgid: '%(count)s mail',
          plural_index: 1
        }
      });
    });

    it('should convert plural entries with context to two linked keys', () => {
      const entries = [
        {
          msgid: '%(count)s page',
          msgstr: ['%(count)s sida', '%(count)s sidor'],
          msgctxt: 'navigation',
          msgid_plural: '%(count)s pages',
          comments: undefined
        }
      ];

      const result = poEntriesToApiFormat(entries);

      // Should create two linked keys with context
      expect(result['navigation|%(count)s page']).toEqual({
        value: '%(count)s sida',
        context: 'navigation',
        metadata: {
          po_plural: true,
          msgid_plural: '%(count)s pages',
          plural_index: 0
        }
      });

      expect(result['navigation|%(count)s page__plural_1']).toEqual({
        value: '%(count)s sidor',
        context: 'navigation',
        metadata: {
          po_plural: true,
          msgid: '%(count)s page',
          plural_index: 1
        }
      });
    });

    it('should convert plural entries with empty translations in source language', () => {
      const entries = [
        {
          msgid: '%(count)s item',
          msgstr: ['', ''],
          msgctxt: undefined,
          msgid_plural: '%(count)s items',
          comments: undefined
        }
      ];

      const result = poEntriesToApiFormat(entries, {
        sourceLanguage: 'sv',
        currentLanguage: 'sv'
      });

      // Source language should use msgid/msgid_plural as fallback values
      expect(result['%(count)s item']).toEqual({
        value: '%(count)s item',
        metadata: {
          po_plural: true,
          msgid_plural: '%(count)s items',
          plural_index: 0
        }
      });

      expect(result['%(count)s item__plural_1']).toEqual({
        value: '%(count)s items',
        metadata: {
          po_plural: true,
          msgid: '%(count)s item',
          plural_index: 1
        }
      });
    });

    it('should convert plural entries with empty translations in target language', () => {
      const entries = [
        {
          msgid: '%(count)s item',
          msgstr: ['', ''],
          msgctxt: undefined,
          msgid_plural: '%(count)s items',
          comments: undefined
        }
      ];

      const result = poEntriesToApiFormat(entries, {
        sourceLanguage: 'sv',
        currentLanguage: 'en'
      });

      // Target language should return empty values for empty translations
      expect(result['%(count)s item']).toEqual({
        value: '',
        metadata: {
          po_plural: true,
          msgid_plural: '%(count)s items',
          plural_index: 0
        }
      });

      expect(result['%(count)s item__plural_1']).toEqual({
        value: '',
        metadata: {
          po_plural: true,
          msgid: '%(count)s item',
          plural_index: 1
        }
      });
    });

    it('should preserve existing metadata in plural entries', () => {
      const entries = [
        {
          msgid: '%(count)s guide',
          msgstr: ['%(count)s guide', '%(count)s guider'],
          msgctxt: undefined,
          msgid_plural: '%(count)s guides',
          comments: {
            extracted: 'Translators: Number of guides'
          }
        }
      ];

      const result = poEntriesToApiFormat(entries);

      // Should preserve translator comments in both forms
      expect(result['%(count)s guide'].metadata).toEqual({
        po_plural: true,
        msgid_plural: '%(count)s guides',
        plural_index: 0,
        translator_comments: 'Number of guides'
      });

      expect(result['%(count)s guide__plural_1'].metadata).toEqual({
        po_plural: true,
        msgid: '%(count)s guide',
        plural_index: 1,
        translator_comments: 'Number of guides'
      });
    });

    it('should preserve translator comments in plural forms', () => {
      const entries = [
        {
          msgid: '%(count)d item',
          msgstr: ['%(count)d item', '%(count)d items'],
          msgid_plural: '%(count)d items',
          comments: {
            extracted: ['Translators: Count of items in shopping cart']
          }
        }
      ];

      const result = poEntriesToApiFormat(entries);

      // Both singular and plural should have translator comments
      expect(result['%(count)d item'].metadata.translator_comments).toBe('Count of items in shopping cart');
      expect(result['%(count)d item__plural_1'].metadata.translator_comments).toBe('Count of items in shopping cart');
    });
  });

  describe('findMissingPoTranslations', () => {
    it('should find missing translations', () => {
      const sourceContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hello"

msgid "Goodbye"
msgstr "Goodbye"
`;

      const targetContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hej"

msgid "Goodbye"
msgstr ""
`;

      const result = findMissingPoTranslations(sourceContent, targetContent);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        key: 'Goodbye',
        context: undefined,
        value: 'Goodbye',
        isPlural: false,
        pluralForm: undefined
      });
    });

    it('should find missing translations with context', () => {
      const sourceContent = `msgid ""
msgstr ""

msgctxt "ShortenedMonths"
msgid "May"
msgstr "May"

msgctxt "permission"
msgid "May"
msgstr "May"
`;

      const targetContent = `msgid ""
msgstr ""

msgctxt "ShortenedMonths"
msgid "May"
msgstr "Maj"

msgctxt "permission"
msgid "May"
msgstr ""
`;

      const result = findMissingPoTranslations(sourceContent, targetContent);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        key: 'May',
        context: 'permission',
        value: 'May',
        isPlural: false,
        pluralForm: undefined
      });
    });
  });
});