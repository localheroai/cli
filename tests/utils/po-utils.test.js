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

  describe('updatePoFile', () => {
    it('should update translations in .po file', () => {
      const originalContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr ""

msgctxt "ShortenedMonths"
msgid "May"
msgstr ""
`;

      const translations = {
        'Hello': 'Hej',
        'ShortenedMonths|May': 'Maj'
      };

      const result = updatePoFile(originalContent, translations);

      expect(result).toContain('msgstr "Hej"');
      expect(result).toContain('msgstr "Maj"');
    });
  });
});