import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('po-surgical', () => {
  let surgicalUpdatePoFile;
  let parsePoFile;
  let createUniqueKey;

  const loadFixture = (name) => {
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'po', `${name}.po`);
    return readFileSync(fixturePath, 'utf-8');
  };

  beforeEach(async () => {
    jest.resetModules();

    const surgicalModule = await import('../../src/utils/po-surgical.js');
    const utilsModule = await import('../../src/utils/po-utils.js');

    surgicalUpdatePoFile = surgicalModule.surgicalUpdatePoFile;
    parsePoFile = utilsModule.parsePoFile;
    createUniqueKey = utilsModule.createUniqueKey;
  });

  describe('No Changes Scenarios', () => {
    test('should return original content when no translations provided', () => {
      const original = loadFixture('simple');
      const result = surgicalUpdatePoFile(original, {});
      expect(result).toBe(original);
    });

    test('should return original content when translations match existing values', () => {
      const original = loadFixture('simple');
      const translations = {
        'Hello': 'Hello',
        'Goodbye': 'Goodbye'
      };
      const result = surgicalUpdatePoFile(original, translations);
      expect(result).toBe(original);
    });

    test('should preserve multiline formatting when no changes', () => {
      const original = loadFixture('multiline');
      const result = surgicalUpdatePoFile(original, {});
      expect(result).toBe(original);
    });
  });

  describe('Simple Translation Updates', () => {
    test('should update single translation without affecting others', () => {
      const original = loadFixture('simple');
      const translations = {
        'Hello': 'Hej'
      };
      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgid "Hello"\nmsgstr "Hej"');
      expect(result).toContain('msgid "Goodbye"\nmsgstr "Goodbye"'); // Unchanged
      expect(result.split('\\n').length).toBe(original.split('\\n').length); // Same line count
    });

    test('should update multiple translations', () => {
      const original = loadFixture('simple');
      const translations = {
        'Hello': 'Hej',
        'Goodbye': 'Hej då'
      };
      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgid "Hello"\nmsgstr "Hej"');
      expect(result).toContain('msgid "Goodbye"\nmsgstr "Hej då"');
    });
  });

  describe('Multiline String Handling', () => {
    test('should preserve multiline format when updating translations', () => {
      const original = loadFixture('multiline');
      const longMessage = 'This is a very long message that spans multiple lines for better readability and to test how we handle line wrapping scenarios.';
      const translations = {
        [longMessage]: 'Detta är den uppdaterade översättningen som också borde behålla sitt flerradiga format.'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgid ""\n"This is a very long message');
      expect(result).toContain('msgstr ""\n"Detta är den uppdaterade översättningen');
      expect(result).toContain('msgid "Short message"\nmsgstr "Kort meddelande"');
    });

    test('should handle single-line to multiline conversion intelligently', () => {
      const original = loadFixture('multiline');
      const translations = {
        'Short message': 'Detta är nu ett mycket längre meddelande som kanske behöver brytas över flera rader'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('Detta är nu ett mycket längre meddelande');
      expect(result).toContain('flera rader');
      expect(result).toContain('msgid "Short message"');
    });
  });

  describe('Plural Forms Handling', () => {
    test('should update only changed plural form', () => {
      const original = loadFixture('plurals');
      const translations = {
        '%(count)d items': '%(count)d föremål' // Only update plural form
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgstr[0] "%(count)d objekt"');
      expect(result).toContain('msgstr[1] "%(count)d föremål"');
    });

    test('should update both singular and plural forms', () => {
      const original = loadFixture('plurals');
      const translations = {
        '%(count)d item': '%(count)d artikel',
        '%(count)d items': '%(count)d artiklar'
      };

      const result = surgicalUpdatePoFile(original, translations);


      expect(result).toContain('%(count)d artikel');
      expect(result).toContain('%(count)d artiklar');
    });

    test('should handle Swedish-style plurals where msgid and msgid_plural are same', () => {
      const original = loadFixture('plurals');
      const translations = {
        '%(count)s mail': '%(count)s brev'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('%(count)s brev');
      expect(result).toContain('%(count)s e-post');
    });

    test('should handle __plural_1 suffix keys correctly', () => {
      const original = `# Test file for __plural_1 suffix handling
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#: test.py
msgid "item"
msgid_plural "items"
msgstr[0] "objekt"
msgstr[1] ""
`;

      const translations = {
        'item__plural_1': 'objekts' // This should update msgstr[1]
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgstr[1] "objekts"');
      expect(result).toContain('msgstr[0] "objekt"');
      expect(result).not.toContain('msgstr[1] ""');
    });
  });

  describe('Context (msgctxt) Handling', () => {
    test('should update correct contextual translation', () => {
      const original = loadFixture('context');
      const translations = {
        'menu|File': 'Fil',
        'document|File': 'Dokument'
      };

      const result = surgicalUpdatePoFile(original, translations);


      const lines = result.split('\n');
      const menuIndex = lines.findIndex(line => line.includes('msgctxt "menu"'));
      const docIndex = lines.findIndex(line => line.includes('msgctxt "document"'));

      expect(lines[menuIndex + 2]).toContain('msgstr "Fil"');
      expect(lines[docIndex + 2]).toContain('msgstr "Dokument"');
    });

    test('should handle multiline context', () => {
      const original = loadFixture('context');
      const contextKey = 'This is a multiline context that explains the usage of this particular translation string in detail.|Save';
      const translations = {
        [contextKey]: 'Spara ändringar'
      };

      const result = surgicalUpdatePoFile(original, translations);
      expect(result).toContain('msgstr "Spara ändringar"');
    });
  });

  describe('Edge Cases', () => {
    test('should handle escaped quotes correctly', () => {
      const original = loadFixture('edge-cases');
      const translations = {
        'He said "Hello" to me': 'Han sa "Hej då" till mig'
      };

      const result = surgicalUpdatePoFile(original, translations);
      // The original msgstr is "Han sa \"Hej\" till mig" and should be updated to "Han sa \"Hej då\" till mig"
      expect(result).toContain('msgstr "Han sa \\"Hej då\\" till mig"');
    });

    test('should handle comments within translation entries', () => {
      const original = `# Header comment
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "test"
# Comment between msgid and msgstr should not break translation lookup
msgstr "original"

msgid "another"
msgstr "annan"`;

      const translations = {
        'test': 'uppdaterad'
      };

      const result = surgicalUpdatePoFile(original, translations);


      expect(result).toContain('msgstr "uppdaterad"');
      expect(result).toContain('# Comment between msgid and msgstr');
      expect(result).toContain('msgstr "annan"');
    });

    test('should handle empty msgstr updates', () => {
      const original = loadFixture('edge-cases');
      const translations = {
        'Empty translation': 'Nu finns översättning'
      };

      const result = surgicalUpdatePoFile(original, translations);
      expect(result).toContain('msgstr "Nu finns översättning"');
    });

    test('should preserve very long single lines', () => {
      const original = loadFixture('edge-cases');
      const longMsg = 'This is a very long single-line message that might exceed typical line length limits used in gettext files and should not be wrapped by our surgical editing approach because it was originally formatted this way';
      const translations = {
        [longMsg]: 'Detta är en uppdaterad lång rad som också ska behålla sin format'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Should not introduce line breaks in single-line entries
      const lines = result.split('\\n');
      const updatedLine = lines.find(line => line.includes('Detta är en uppdaterad lång rad'));
      expect(updatedLine).toBeDefined();
      expect(updatedLine).not.toMatch(/^".*"$/); // Should not be a continuation line
    });

    test('should handle special characters correctly', () => {
      const original = loadFixture('edge-cases');
      const translations = {
        'Special chars: åäö ñ € © ® ™': 'Uppdaterade specialtecken: åäö ñ € © ® ™'
      };

      const result = surgicalUpdatePoFile(original, translations);
      expect(result).toContain('msgstr "Uppdaterade specialtecken: åäö ñ € © ® ™"');
    });
  });

  describe('Header and Comment Preservation', () => {
    test('should preserve all comments and references', () => {
      const original = loadFixture('plurals');
      const translations = {
        '%(count)d item': '%(count)d ny översättning'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Should preserve all comments
      expect(result).toContain('#: helpers.py');
      expect(result).toContain('#, python-format');
      expect(result).toContain('#: views.py');
      expect(result).toContain('#: templates/dashboard.html');
    });

    test('should preserve header section exactly', () => {
      const original = loadFixture('multiline');
      const translations = {
        'Short message': 'Kort uppdaterat meddelande'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Header should be identical
      const originalLines = original.split('\\n');
      const resultLines = result.split('\\n');
      const headerEnd = originalLines.findIndex((line, index) => index > 0 && line === '' && originalLines[index - 1].includes('"'));

      for (let i = 0; i <= headerEnd; i++) {
        expect(resultLines[i]).toBe(originalLines[i]);
      }
    });
  });

  describe('Format Preservation', () => {
    test('should preserve exact formatting when content is unchanged', () => {
      const original = loadFixture('format-preservation');
      const translations = {
        // Providing exact same translations - should not change formatting
        '%(limited_access_editors_count)s användare har begränsad behörighet i Kundo.': '%(limited_access_editors_count)s Nutzer haben eingeschränkte Zugriffsberechtigung in Kundo.',
        'Save': 'Spara'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Result should be identical to original when content hasn't changed
      expect(result).toBe(original);
    });

    test('should preserve multiline formatting patterns when content changes', () => {
      const original = loadFixture('format-preservation');
      const translations = {
        // Change content but format should be preserved
        '%(count)d users have full access.': 'New singular translation that is quite long and should maintain multiline format with empty first line like the original had.'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Should maintain multiline format with empty first line
      expect(result).toContain('msgstr[0] ""');
      expect(result).toContain('New singular translation');
      // Should update only the singular form (msgstr[0]), plural form (msgstr[1]) should remain unchanged
      const lines = result.split('\n');
      const msgstr0Line = lines.findIndex(line => line.includes('New singular translation'));
      const msgstr1Line = lines.findIndex(line => line.includes('msgstr[1] ""'));
      expect(msgstr0Line).toBeGreaterThan(-1);
      expect(msgstr1Line).toBeGreaterThan(-1);
      expect(msgstr1Line).toBeGreaterThan(msgstr0Line); // msgstr[1] should come after msgstr[0]
    });

    test('should preserve single-line format for short translations', () => {
      const original = loadFixture('format-preservation');
      const translations = {
        'Save': 'Updated' // Short translation should stay single-line
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Should maintain single-line format
      expect(result).toContain('msgid "Save"\nmsgstr "Updated"');
      // Should not have been converted to multiline
      expect(result).not.toContain('msgid "Save"\nmsgstr ""');
    });
  });

  describe('Performance and Robustness', () => {
    test('should handle large files efficiently', () => {
      // Create a large .po content
      let largeContent = loadFixture('simple');

      for (let i = 0; i < 100; i++) {
        largeContent += `\n\nmsgid "Test message ${i}"\nmsgstr "Test översättning ${i}"`;
      }

      const translations = {
        'Test message 50': 'Uppdaterad översättning 50'
      };

      const start = Date.now();
      const result = surgicalUpdatePoFile(largeContent, translations);
      const duration = Date.now() - start;

      expect(result).toContain('msgstr "Uppdaterad översättning 50"');
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    test('should validate that result is still parseable', () => {
      const original = loadFixture('plurals');
      const translations = {
        '%(count)d item': '%(count)d uppdaterad',
        '%(count)s conversation': '%(count)s uppdaterad konversation'
      };

      const result = surgicalUpdatePoFile(original, translations);

      // Should still be parseable by gettext-parser
      expect(() => {
        parsePoFile(result);
      }).not.toThrow();

      // Should have expected content
      const parsed = parsePoFile(result);
      expect(parsed.entries.length).toBeGreaterThan(0);
    });
  });

  describe('New Entry Creation', () => {
    test('should add new translation entries that do not exist in the original file', () => {
      const original = loadFixture('simple');
      const translations = {
        'New Key': 'Ny Nyckel',
        'Another New Key': 'En Annan Ny Nyckel'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgid "New Key"');
      expect(result).toContain('msgstr "Ny Nyckel"');
      expect(result).toContain('msgid "Another New Key"');
      expect(result).toContain('msgstr "En Annan Ny Nyckel"');
    });

    test('should add new translation entries with context', () => {
      const original = loadFixture('simple');
      const translations = {
        'context|New Key': 'Ny Nyckel Med Kontext'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgctxt "context"');
      expect(result).toContain('msgid "New Key"');
      expect(result).toContain('msgstr "Ny Nyckel Med Kontext"');
    });

    test('should add new plural translation entries', () => {
      const original = loadFixture('simple');
      const translations = {
        'New Item': 'Nytt Objekt',
        'New Item__plural_1': 'Nya Objekt'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgid "New Item"');
      expect(result).toContain('msgid_plural "New Items"');
      expect(result).toContain('msgstr[0] "Nytt Objekt"');
      expect(result).toContain('msgstr[1] "Nya Objekt"');
    });

    test('should skip adding new entries when msgid equals msgstr in source language', () => {
      const original = loadFixture('simple');
      const translations = {
        'English Key': 'English Key' // Same as msgid
      };

      const result = surgicalUpdatePoFile(original, translations, {
        sourceLanguage: 'en',
        targetLanguage: 'en'
      });


      expect(result).not.toContain('msgid "English Key"');
    });

    test('should add new entries when msgid equals msgstr but not source language', () => {
      const original = loadFixture('simple');
      const translations = {
        'Same Text': 'Same Text' // Valid translation for target language
      };

      const result = surgicalUpdatePoFile(original, translations, {
        sourceLanguage: 'en',
        targetLanguage: 'sv'
      });


      expect(result).toContain('msgid "Same Text"');
      expect(result).toContain('msgstr "Same Text"');
    });
  });

  describe('Source Content msgid_plural Lookup', () => {
    test('should use sourceContent to find proper msgid_plural when creating new plural entries', () => {
      const sourceContent = `msgid ""
msgstr ""

msgid "%(count)s file"
msgid_plural "%(count)s files"
msgstr[0] "%(count)s file"
msgstr[1] "%(count)s files"
`;

      const targetContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hej"
`;

      const translations = {
        '%(count)s file': '%(count)s fil',
        '%(count)s file__plural_1': '%(count)s filer'
      };

      const result = surgicalUpdatePoFile(targetContent, translations, {
        sourceContent: sourceContent
      });


      expect(result).toContain('msgid "%(count)s file"');
      expect(result).toContain('msgid_plural "%(count)s files"');
      expect(result).toContain('msgstr[0] "%(count)s fil"');
      expect(result).toContain('msgstr[1] "%(count)s filer"');
    });

    test('should use sourceContent for msgid_plural lookup with context', () => {
      const sourceContent = `msgid ""
msgstr ""

msgctxt "navigation"
msgid "%(count)s page"
msgid_plural "%(count)s pages"
msgstr[0] "%(count)s page"
msgstr[1] "%(count)s pages"
`;

      const targetContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hej"
`;

      const translations = {
        'navigation|%(count)s page': '%(count)s sida',
        'navigation|%(count)s page__plural_1': '%(count)s sidor'
      };

      const result = surgicalUpdatePoFile(targetContent, translations, {
        sourceContent: sourceContent
      });


      expect(result).toContain('msgctxt "navigation"');
      expect(result).toContain('msgid "%(count)s page"');
      expect(result).toContain('msgid_plural "%(count)s pages"');
      expect(result).toContain('msgstr[0] "%(count)s sida"');
      expect(result).toContain('msgstr[1] "%(count)s sidor"');
    });

    test('should fall back to translation as msgid_plural when sourceContent is not available', () => {
      const targetContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hej"
`;

      const translations = {
        '%(count)s item': '%(count)s objekt',
        '%(count)s item__plural_1': '%(count)s objekt' // Swedish plural same as singular
      };

      const result = surgicalUpdatePoFile(targetContent, translations);


      expect(result).toContain('msgid "%(count)s item"');
      expect(result).toContain('msgid_plural "%(count)s items"');
      expect(result).toContain('msgstr[0] "%(count)s objekt"');
      expect(result).toContain('msgstr[1] "%(count)s objekt"');
    });

    test('should handle sourceContent parsing errors gracefully', () => {
      const invalidSourceContent = `invalid po content {{{`;

      const targetContent = `msgid ""
msgstr ""

msgid "Hello"
msgstr "Hej"
`;

      const translations = {
        'New Item': 'Nytt Objekt',
        'New Item__plural_1': 'Nya Objekt'
      };

      // Suppress console.warn for this test
      const originalWarn = console.warn;
      console.warn = jest.fn();

      const result = surgicalUpdatePoFile(targetContent, translations, {
        sourceContent: invalidSourceContent
      });

      console.warn = originalWarn;

      expect(result).toContain('msgid "New Item"');
      expect(result).toContain('msgid_plural "New Items"');
    });
  });

  describe('Multiline Word Spacing', () => {
    test('should preserve spaces when breaking long lines into chunks', () => {
      const original = `# Test file for multiline spacing
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Activate the sources you want your AI drafts to retrieve information from. If an external system is integrated with the customer card, information from there will also be used."
msgstr ""
`;

      const translations = {
        'Activate the sources you want your AI drafts to retrieve information from. If an external system is integrated with the customer card, information from there will also be used.': 'Aktivera källorna du vill att dina AI-utkast ska hämta information från. Om ett externt system är integrerat med kundkortet kommer även information därifrån att användas.'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).not.toContain('hämtainformation');
      expect(result).not.toContain('därifrånatt');
      
      expect(result).toContain('hämta ');
      expect(result).toContain('information från');
      expect(result).toContain('därifrån att');
      
      expect(result).toContain('Aktivera källorna');
      expect(result).toContain('Om ett externt system');
    });

    test('should maintain proper word spacing in long translated text', () => {
      const original = `# Test file for long text spacing
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "This is a very long message that contains multiple words and should maintain proper spacing when broken into chunks"
msgstr ""
`;

      const translations = {
        'This is a very long message that contains multiple words and should maintain proper spacing when broken into chunks': 'This translation is also very long and contains many words that need to maintain proper spacing between them when the line gets broken into multiple chunks for formatting'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).not.toContain('spacingwhen');
      expect(result).not.toContain('themwhen');
      expect(result).not.toContain('multiplechunks');
      
      expect(result).toContain('spacing between them');
      expect(result).toContain('multiple chunks for');
      
      expect(result).toContain('maintain proper spacing between them when');
    });

    test('should handle single line format appropriately', () => {
      const original = `# Test file for single line format
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Short message"
msgstr ""
`;

      const translations = {
        'Short message': 'Kort meddelande'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).toContain('msgstr "Kort meddelande"');
      expect(result).not.toContain('msgstr "Kort meddelande "');
      expect(result).not.toContain('msgstr ""\n"Kort meddelande"');
    });

    test('should handle complex multiline translations with proper spacing', () => {
      const original = `# Test file for complex multiline content
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Aktivera de källor du vill att dina AI-utkast ska hämta information från. Har ni integrerat ett externt system med kundkortet används även information därifrån."
msgstr ""
`;

      const translations = {
        'Aktivera de källor du vill att dina AI-utkast ska hämta information från. Har ni integrerat ett externt system med kundkortet används även information därifrån.': 'Activeer de bronnen waarvan je wilt dat je AI-schetsen informatie ophalen. Als er een extern systeem is geïntegreerd met het klantprofiel, wordt ook die informatie gebruikt.'
      };

      const result = surgicalUpdatePoFile(original, translations);

      expect(result).not.toContain('schetseninformatie');
      expect(result).not.toContain('isgeïntegreerd'); 
      expect(result).not.toContain('informatiegebruikt');
      
      expect(result).toContain('AI-schetsen ');
      expect(result).toContain('informatie ophalen');
      expect(result).toContain('is ');
      expect(result).toContain('geïntegreerd met');
      expect(result).toContain('informatie ');
      expect(result).toContain('gebruikt');
      
      expect(result).toContain('Activeer de bronnen');
      expect(result).toContain('Als er een extern systeem');
    });
  });
});