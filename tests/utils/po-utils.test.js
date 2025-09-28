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

      const parsed = { headers: {}, entries };
      const result = poEntriesToApiFormat(parsed);

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

      const parsed = { headers: {}, entries };
      const result = poEntriesToApiFormat(parsed);

      expect(result['Hello']).toEqual({
        value: 'Hej',
        metadata: 'hello_greeting'
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

      const parsed = { headers: {}, entries };
      const result = poEntriesToApiFormat(parsed);

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

      const parsed = { headers: {}, entries };
      const result = poEntriesToApiFormat(parsed);

      expect(result['%(count)d item'].metadata.translator_comments).toBe('Count of items in shopping cart');
      expect(result['%(count)d item__plural_1'].metadata.translator_comments).toBe('Count of items in shopping cart');
    });
  });

  describe('Multi-plural forms', () => {
    let surgicalUpdatePoFile;

    beforeEach(async () => {
      const poSurgicalModule = await import('../../src/utils/po-surgical.js');
      surgicalUpdatePoFile = poSurgicalModule.surgicalUpdatePoFile;
    });

    it('should handle Polish 3-form plurals round-trip', () => {
      const polishPoFile = `# Polish translation with 3 plural forms
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: pl\\n"
"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"

#: templates/file_count.html
msgid "%d file"
msgid_plural "%d files"
msgstr[0] "%d plik"
msgstr[1] "%d pliki"
msgstr[2] "%d plików"

msgid "Hello"
msgstr "Cześć"
`;

      const parsed = parsePoFile(polishPoFile);
      expect(parsed.entries).toHaveLength(2);

      const apiFormat = poEntriesToApiFormat(parsed);
      expect(Object.keys(apiFormat)).toHaveLength(4);

      // Check all Polish plural forms
      expect(apiFormat['%d file']).toEqual({
        value: '%d plik',
        metadata: {
          po_plural: true,
          msgid_plural: '%d files',
          plural_index: 0
        }
      });

      expect(apiFormat['%d file__plural_1']).toEqual({
        value: '%d pliki',
        metadata: {
          po_plural: true,
          msgid: '%d file',
          plural_index: 1
        }
      });

      expect(apiFormat['%d file__plural_2']).toEqual({
        value: '%d plików',
        metadata: {
          po_plural: true,
          msgid: '%d file',
          plural_index: 2
        }
      });

      expect(apiFormat['Hello']).toEqual({
        value: 'Cześć'
      });

      const apiResponse = {
        '%d file': '%d dokument',
        '%d file__plural_1': '%d dokumenty',
        '%d file__plural_2': '%d dokumentów',
        'Hello': 'Witaj'
      };

      // Apply translations back to PO file
      const updatedPoFile = surgicalUpdatePoFile(polishPoFile, apiResponse);

      expect(updatedPoFile).toContain('%d dokument');
      expect(updatedPoFile).toContain('%d dokumenty');
      expect(updatedPoFile).toContain('%d dokumentów');
      expect(updatedPoFile).toContain('msgstr "Witaj"');

      const finalParsed = parsePoFile(updatedPoFile);
      const fileEntry = finalParsed.entries.find(e => e.msgid === '%d file');

      expect(fileEntry).toBeTruthy();
      expect(fileEntry.msgstr[0]).toBe('%d dokument');
      expect(fileEntry.msgstr[1]).toBe('%d dokumenty');
      expect(fileEntry.msgstr[2]).toBe('%d dokumentów');
      expect(fileEntry.msgid_plural).toBe('%d files');
    });

    it('should handle Arabic 6-form plurals round-trip', () => {
      const arabicPoFile = `# Arabic translation with 6 plural forms
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ar\\n"
"Plural-Forms: nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);\\n"

msgid "%d book"
msgid_plural "%d books"
msgstr[0] "لا كتب"
msgstr[1] "كتاب واحد"
msgstr[2] "كتابان"
msgstr[3] "%d كتب"
msgstr[4] "%d كتاباً"
msgstr[5] "%d كتاب"
`;

      const parsed = parsePoFile(arabicPoFile);
      const apiFormat = poEntriesToApiFormat(parsed);

      expect(Object.keys(apiFormat)).toHaveLength(6);

      for (let i = 0; i < 6; i++) {
        const suffix = i === 0 ? '' : `__plural_${i}`;
        const keyName = '%d book' + suffix;
        expect(apiFormat[keyName]).toBeTruthy();
        expect(apiFormat[keyName].metadata.plural_index).toBe(i);
      }

      const apiResponse = {
        '%d book': 'لا مجلدات',
        '%d book__plural_1': 'مجلد واحد',
        '%d book__plural_2': 'مجلدان',
        '%d book__plural_3': '%d مجلدات',
        '%d book__plural_4': '%d مجلداً',
        '%d book__plural_5': '%d مجلد'
      };

      const updatedPoFile = surgicalUpdatePoFile(arabicPoFile, apiResponse);

      expect(updatedPoFile).toContain('لا مجلدات');
      expect(updatedPoFile).toContain('مجلد واحد');
      expect(updatedPoFile).toContain('مجلدان');
      expect(updatedPoFile).toContain('%d مجلدات');
      expect(updatedPoFile).toContain('%d مجلداً');
      expect(updatedPoFile).toContain('%d مجلد');
    });

    it('should handle context with multiple plural forms', () => {
      const mixedPoFile = `msgid ""
msgstr ""
"Plural-Forms: nplurals=4; plural=(n==1 && n%10!=11 ? 0 : n>=2 && n<=4 && (n%10<10 || n%10>=20) ? 1 : 2);\\n"

#: With context
msgctxt "files"
msgid "%d item"
msgid_plural "%d items"
msgstr[0] "%d věc"
msgstr[1] "%d věci"
msgstr[2] "%d věcí"
msgstr[3] "%d věcí"

msgid "Simple"
msgstr "Jednoduché"
`;

      const parsed = parsePoFile(mixedPoFile);
      const apiFormat = poEntriesToApiFormat(parsed);

      // Should handle context + 4 plural forms + 1 regular = 5 keys
      expect(Object.keys(apiFormat)).toHaveLength(5);

      expect(apiFormat['files|%d item'].context).toBe('files');
      expect(apiFormat['files|%d item__plural_1'].context).toBe('files');
      expect(apiFormat['files|%d item__plural_2'].context).toBe('files');
      expect(apiFormat['files|%d item__plural_3'].context).toBe('files');
    });

    it('should maintain backward compatibility with 2-form files', () => {
      const traditionalPoFile = `msgid ""
msgstr ""
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "%d message"
msgid_plural "%d messages"
msgstr[0] "%d meddelande"
msgstr[1] "%d meddelanden"
`;

      const parsed = parsePoFile(traditionalPoFile);
      const apiFormat = poEntriesToApiFormat(parsed);

      expect(Object.keys(apiFormat)).toHaveLength(2);
      expect(apiFormat['%d message']).toBeTruthy();
      expect(apiFormat['%d message__plural_1']).toBeTruthy();

      const apiResponse = {
        '%d message': '%d brev',
        '%d message__plural_1': '%d brev'
      };

      const updatedPoFile = surgicalUpdatePoFile(traditionalPoFile, apiResponse);
      expect(updatedPoFile).toContain('%d brev');
      expect(updatedPoFile.split('%d brev').length - 1).toBe(2);
    });

    it('should default to 2 plural forms when nplurals header missing', () => {
      const noHeaderPoFile = `msgid ""
msgstr ""

msgid "%d file"
msgid_plural "%d files"
msgstr[0] "%d fil"
msgstr[1] "%d filer"
`;

      const parsed = parsePoFile(noHeaderPoFile);
      const apiFormat = poEntriesToApiFormat(parsed);

      expect(Object.keys(apiFormat)).toHaveLength(2);
      expect(apiFormat['%d file']).toBeTruthy();
      expect(apiFormat['%d file__plural_1']).toBeTruthy();
    });

    it('should handle invalid nplurals values gracefully', () => {
      const invalidHeaderPoFile = `msgid ""
msgstr ""
"Plural-Forms: nplurals=999; plural=(n==1 ? 0 : 1);\\n"

msgid "%d item"
msgid_plural "%d items"
msgstr[0] "%d artikel"
msgstr[1] "%d artiklar"
`;

      const parsed = parsePoFile(invalidHeaderPoFile);
      const apiFormat = poEntriesToApiFormat(parsed);

      // Should fallback to 2 forms despite invalid nplurals=999
      expect(Object.keys(apiFormat)).toHaveLength(2);
      expect(apiFormat['%d item']).toBeTruthy();
      expect(apiFormat['%d item__plural_1']).toBeTruthy();
      expect(apiFormat['%d item__plural_2']).toBeFalsy();
    });

    it('should use msgid/msgid_plural as fallback in source language', () => {
      const sourcePoFile = `msgid ""
msgstr ""
"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 ? 1 : 2);\\n"

msgid "%d day"
msgid_plural "%d days"
msgstr[0] ""
msgstr[1] ""
msgstr[2] ""
`;

      const parsed = parsePoFile(sourcePoFile);
      const apiFormat = poEntriesToApiFormat(parsed, {
        sourceLanguage: 'en',
        currentLanguage: 'en'
      });

      // Source language should use msgid for form 0, msgid_plural for others
      expect(apiFormat['%d day'].value).toBe('%d day');
      expect(apiFormat['%d day__plural_1'].value).toBe('%d days');
      expect(apiFormat['%d day__plural_2'].value).toBe('%d days');
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

    it('should detect missing plural forms based on target language nplurals', () => {
      // English source (2 forms) -> Polish target (3 forms)
      const sourceContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "%(count)d book"
msgid_plural "%(count)d books"
msgstr[0] "%(count)d book"
msgstr[1] "%(count)d books"
`;

      const targetContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"

msgid "%(count)d book"
msgid_plural "%(count)d books"
msgstr[0] "%(count)d książka"
msgstr[1] "%(count)d książki"
msgstr[2] ""
`;

      const result = findMissingPoTranslations(sourceContent, targetContent);

      // Should detect that msgstr[2] is missing for Polish
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        key: '%(count)d book__plural_2',
        context: undefined,
        value: '%(count)d books',
        isPlural: true,
        pluralForm: '%(count)d books'
      });
    });

    it('should detect all missing plural forms for Arabic (6 forms)', () => {
      // English source (2 forms) -> Arabic target (6 forms)
      const sourceContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "%(count)d item"
msgid_plural "%(count)d items"
msgstr[0] "%(count)d item"
msgstr[1] "%(count)d items"
`;

      const targetContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);\\n"

msgid "%(count)d item"
msgid_plural "%(count)d items"
msgstr[0] ""
msgstr[1] ""
msgstr[2] ""
msgstr[3] ""
msgstr[4] ""
msgstr[5] ""
`;

      const result = findMissingPoTranslations(sourceContent, targetContent);

      // Should detect all 6 missing forms for Arabic
      expect(result).toHaveLength(6);

      const expectedKeys = [
        '%(count)d item',
        '%(count)d item__plural_1',
        '%(count)d item__plural_2',
        '%(count)d item__plural_3',
        '%(count)d item__plural_4',
        '%(count)d item__plural_5'
      ];

      expectedKeys.forEach((expectedKey, index) => {
        expect(result[index].key).toBe(expectedKey);
        expect(result[index].isPlural).toBe(true);
        expect(result[index].pluralForm).toBe('%(count)d items');
      });
    });

    it('should provide correct value for each plural form', () => {
      // English source (2 forms) -> Polish target (3 forms)
      const sourceContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "%(count)d task"
msgid_plural "%(count)d tasks"
msgstr[0] "%(count)d task"
msgstr[1] "%(count)d tasks"
`;

      const targetContent = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"

msgid "%(count)d task"
msgid_plural "%(count)d tasks"
msgstr[0] ""
msgstr[1] ""
msgstr[2] ""
`;

      const result = findMissingPoTranslations(sourceContent, targetContent);

      expect(result).toHaveLength(3);

      // Check that the values are correct for each form
      expect(result[0]).toEqual({
        key: '%(count)d task',
        context: undefined,
        value: '%(count)d task',  // singular form gets msgid
        isPlural: true,
        pluralForm: '%(count)d tasks'
      });

      expect(result[1]).toEqual({
        key: '%(count)d task__plural_1',
        context: undefined,
        value: '%(count)d tasks',  // plural forms get msgid_plural
        isPlural: true,
        pluralForm: '%(count)d tasks'
      });

      expect(result[2]).toEqual({
        key: '%(count)d task__plural_2',
        context: undefined,
        value: '%(count)d tasks',  // additional forms also get msgid_plural
        isPlural: true,
        pluralForm: '%(count)d tasks'
      });
    });
  });
});
