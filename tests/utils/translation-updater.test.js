import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import { updateTranslationFile, deleteKeysFromTranslationFile } from '../../src/utils/translation-updater/index.js';

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

    it('preserves double quotes on plain values to avoid unnecessary diffs', async () => {
      const filePath = path.join(tempDir, 'en.yml');
      const initialContent = `en:
  dashboard:
    stats:
      total_tasks: "Total Tasks"
      in_progress: "In Progress"
      completed: "Completed"
      overdue: "Needs attention"
`;
      fs.writeFileSync(filePath, initialContent);

      await updateTranslationFile(filePath, {
        'dashboard.stats.total_tasks': 'Total Tasks',
        'dashboard.stats.overdue': 'Needs attention'
      });

      const updatedContent = fs.readFileSync(filePath, 'utf8');
      expect(updatedContent).toContain('"Total Tasks"');
      expect(updatedContent).toContain('"In Progress"');
      expect(updatedContent).toContain('"Completed"');
      expect(updatedContent).toContain('"Needs attention"');
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
        en: {
          navbar: {
            home: 'Old Home'
          }
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
        en: {
          navbar: {
            home: 'Home',
            about: 'About'
          }
        }
      });
    });

    it('preserves flat JSON structure without adding language wrapper', async () => {
      const filePath = path.join(tempDir, 'flat-translations.json');

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

    describe('JSON file creation', () => {
      it('requires source file for new JSON files', async () => {
        const targetFilePath = path.join(tempDir, 'new-translations.json');
        const translations = {
          'navbar.home': 'Home'
        };

        await expect(updateTranslationFile(targetFilePath, translations, 'en'))
          .rejects
          .toThrow('Source file is required for creating new JSON translation files');
      });

      it('creates new file with flat structure when source is flat', async () => {
        // Create source file without wrapper
        const sourceFilePath = path.join(tempDir, 'source.json');
        const sourceContent = {
          navbar: {
            home: 'Home'
          }
        };
        fs.writeFileSync(sourceFilePath, JSON.stringify(sourceContent, null, 2));

        // Create new target file
        const targetFilePath = path.join(tempDir, 'target.json');
        const translations = {
          'navbar.home': 'Hem',
          'navbar.about': 'Om'
        };

        const result = await updateTranslationFile(targetFilePath, translations, 'sv', sourceFilePath);

        expect(result).toEqual({
          updatedKeys: ['navbar.home', 'navbar.about'],
          created: true
        });

        const fileContent = JSON.parse(fs.readFileSync(targetFilePath, 'utf8'));
        expect(fileContent).toEqual({
          navbar: {
            home: 'Hem',
            about: 'Om'
          }
        });
      });

      it('creates new file with language wrapper when source has wrapper', async () => {
        // Create source file with wrapper
        const sourceFilePath = path.join(tempDir, 'source.json');
        const sourceContent = {
          en: {
            navbar: {
              home: 'Home'
            }
          }
        };
        fs.writeFileSync(sourceFilePath, JSON.stringify(sourceContent, null, 2));

        // Create new target file
        const targetFilePath = path.join(tempDir, 'target.json');
        const translations = {
          'navbar.home': 'Hem',
          'navbar.about': 'Om'
        };

        const result = await updateTranslationFile(targetFilePath, translations, 'sv', sourceFilePath);

        expect(result).toEqual({
          updatedKeys: ['navbar.home', 'navbar.about'],
          created: true
        });

        const fileContent = JSON.parse(fs.readFileSync(targetFilePath, 'utf8'));
        expect(fileContent).toEqual({
          sv: {
            navbar: {
              home: 'Hem',
              about: 'Om'
            }
          }
        });
      });

      it('uses source format when target file exists but is empty', async () => {
        // Create nested source file
        const sourceFilePath = path.join(tempDir, 'en.json');
        const sourceContent = {
          en: {
            navbar: {
              home: 'Home',
              about: 'About'
            }
          }
        };
        fs.writeFileSync(sourceFilePath, JSON.stringify(sourceContent, null, 2));

        // Create empty target file with only language wrapper
        const targetFilePath = path.join(tempDir, 'sv.json');
        fs.writeFileSync(targetFilePath, JSON.stringify({ sv: {} }, null, 2));

        const translations = {
          'navbar.home': 'Hem',
          'navbar.about': 'Om'
        };

        await updateTranslationFile(targetFilePath, translations, 'sv', sourceFilePath);

        const fileContent = JSON.parse(fs.readFileSync(targetFilePath, 'utf8'));
        expect(fileContent).toEqual({
          sv: {
            navbar: {
              home: 'Hem',
              about: 'Om'
            }
          }
        });
      });

      it('uses source format and wrapper when target file is completely empty', async () => {
        // Create nested source file with wrapper
        const sourceFilePath = path.join(tempDir, 'en.json');
        const sourceContent = {
          en: {
            navbar: {
              home: 'Home'
            }
          }
        };
        fs.writeFileSync(sourceFilePath, JSON.stringify(sourceContent, null, 2));

        // Create completely empty target file
        const targetFilePath = path.join(tempDir, 'sv.json');
        fs.writeFileSync(targetFilePath, JSON.stringify({}, null, 2));

        const translations = {
          'navbar.home': 'Hem'
        };

        await updateTranslationFile(targetFilePath, translations, 'sv', sourceFilePath);

        const fileContent = JSON.parse(fs.readFileSync(targetFilePath, 'utf8'));
        expect(fileContent).toEqual({
          sv: {
            navbar: {
              home: 'Hem'
            }
          }
        });
      });

      it('filters out null values before updating', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'greeting': 'Hello',
          'message': null,
          'buttonText': 'Click me',
          'alert': null
        };

        const result = await updateTranslationFile(filePath, translations);

        expect(result).toEqual({
          updatedKeys: ['greeting', 'buttonText'],
          created: true
        });

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('greeting: Hello');
        expect(content).toContain('buttonText: Click me');
        expect(content).not.toContain('message:');
        expect(content).not.toContain('alert:');
      });
    });

    describe('line width handling', () => {
      it('does not wrap long strings to preserve original formatting', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const longString = 'This is a very long string that would normally be wrapped at 80 characters if line width was enabled but should remain on a single line';
        const translations = {
          'description': longString
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        // The long string should be on a single line, not wrapped
        expect(content).toContain(`description: ${longString}`);
        // Should NOT contain the folded block style indicator
        expect(content).not.toMatch(/description: [>|]/);
      });

      it('preserves long strings without wrapping when updating existing file', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const initialContent = `en:
  title: "Short title"
  tagline: "Original tagline"
`;
        fs.writeFileSync(filePath, initialContent);

        const longTagline = 'TaskFlow helps teams stay organized and ship projects together. Simple tools, happy teams, great results for everyone.';
        await updateTranslationFile(filePath, {
          'tagline': longTagline
        }, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        // The updated long string should remain on one line (may be quoted)
        expect(content).toMatch(new RegExp(`tagline: "?${longTagline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`));
        // Should NOT be wrapped to multiple lines with folded/literal block style
        expect(content).not.toMatch(/tagline: >\n/);
        expect(content).not.toMatch(/tagline: \|\n/);
        // Verify the entire tagline appears on a single line (not split across multiple lines)
        const lines = content.split('\n');
        const taglineLine = lines.find(line => line.includes('tagline:'));
        expect(taglineLine).toContain(longTagline);
      });
    });

    describe('multiline string handling', () => {
      it('formats long text from API as multiline when it contains newlines', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'description': 'First line\nSecond line\nThird line',
          'title': 'Simple title'
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        expect(content).toMatch(/en:\n {2}description: \|/);
        expect(content).toContain('    First line');
        expect(content).toContain('    Second line');
        expect(content).toContain('    Third line');
        expect(content).toContain('  title: Simple title');
      });

      it('handles multiline strings with empty lines correctly', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'preamble': 'First paragraph\n\nSecond paragraph\n\nThird paragraph'
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        expect(content).toMatch(/en:\n {2}preamble: \|/);
        expect(content).toContain('    First paragraph');
        expect(content).toContain('');  // Empty line without indentation
        expect(content).toContain('    Second paragraph');
        expect(content).toContain('');  // Empty line without indentation
        expect(content).toContain('    Third paragraph');
      });

      it('preserves existing multiline format when updating other values', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const initialContent = `
en:
  description: |
    First line
    Second line
    Third line
  title: "Old Title"
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'title': 'New Title'
        }, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toMatch(/en:\n\s+description: \|/);
        expect(content).toContain('    First line');
        expect(content).toContain('    Second line');
        expect(content).toContain('    Third line');
        expect(content).toContain('  title: "New Title"');
      });

      it('handles multiline strings with empty lines and special characters', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'content': 'First paragraph\n\nSecond paragraph with special chars: %{name}!\n* List item\n> Quote',
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toMatch(/en:\n {2}content: \|/);
        expect(content).toContain('    First paragraph');
        expect(content).toContain('    ');  // Empty line preserved
        expect(content).toContain('    Second paragraph with special chars: %{name}!');
        expect(content).toContain('    * List item');
        expect(content).toContain('    > Quote');
      });

      it('handles nested multiline strings with proper indentation', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'section.description': 'First line\nSecond line',
          'section.content': 'Regular content'
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        // The document API formats multiline content differently
        expect(content).toMatch(/section:\n.+description: \|-/);
        expect(content).toContain('First line');
        expect(content).toContain('Second line');
        expect(content).toContain('content: Regular content');
      });
    });

    describe('multi-line plain scalar preservation', () => {
      it('does not reformat multi-line plain scalars in untouched locales when adding a key to one locale', async () => {
        const filePath = path.join(tempDir, 'booking_reminder.yml');
        const initialContent = `---
en:
  subject: Before your viewing with %{tenant_name}
  headline: Before your viewing
  description:
    A quick note ahead of the viewing at %{address} with %{tenant_name}.
    Here are the details you'll need.
  note:
    Please arrive a few minutes early. If anything changes, let us know
    via the conversation thread linked below.
  button: Open conversation
sv:
  subject: Inför visningen med %{tenant_name}
  headline: Inför visningen
  description:
    En liten påminnelse inför visningen på %{address} med %{tenant_name}.
    Här är detaljerna du behöver.
  note:
    Var där några minuter i förväg. Om något ändras, hör av dig
    via konversationen länkad nedan.
  button: Öppna konversation
nb:
  subject: Før visningen med %{tenant_name}
  headline: Før visningen
  description:
    En liten påminnelse før visningen på %{address} med %{tenant_name}.
    Her er detaljene du trenger.
  note:
    Vær der noen minutter i forveien. Hvis noe endrer seg, gi oss beskjed
    via samtalen lenket nedenfor.
  button: Åpne samtale
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'subject': 'Ennen näyttöä vuokralaisen %{tenant_name} kanssa'
        }, 'fi');

        const updated = fs.readFileSync(filePath, 'utf8');

        const enBlock = updated.split(/^sv:/m)[0];

        expect(enBlock).toContain('  description:\n');
        expect(enBlock).toContain('    A quick note ahead of the viewing');
        expect(enBlock).toContain('    Here are the details');

        expect(enBlock).toContain('  note:\n');
        expect(enBlock).toContain('    Please arrive a few minutes early');
        expect(enBlock).toContain('    via the conversation thread linked below');

        const enDescriptionAsOneLine = /  description: A quick note ahead of the viewing at %\{address\} with %\{tenant_name\}\. Here are the details/;
        expect(updated).not.toMatch(enDescriptionAsOneLine);

        expect(updated).toContain('fi:');
        expect(updated).toMatch(/subject:\s+"?Ennen näyttöä vuokralaisen %\{tenant_name\} kanssa"?/);
      });

      it('does not collapse a multi-line plain scalar that lives in the SAME locale as the key being added', async () => {
        const filePath = path.join(tempDir, 'tenant_ended.yml');
        const initialContent = `---
en:
  subject: End of lease
  description:
    Your rental period for %{home_address} has now ended. If you have paid
    us a security deposit, we will repay you the money as soon as we have received
    approval from your landlord.
  button: Add bank account details
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'headline': 'End of lease'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        expect(updated).toContain('  description:\n');
        expect(updated).toContain('    Your rental period for %{home_address} has now ended');
        expect(updated).toContain('    us a security deposit');
        expect(updated).toContain('    approval from your landlord');

        const descriptionAsOneLine = /  description: Your rental period for %\{home_address\} has now ended\. If you have paid us a security deposit/;
        expect(updated).not.toMatch(descriptionAsOneLine);

        expect(updated).toContain('headline: End of lease');
      });

      it('does not reformat ANY untouched multi-line plain scalars when adding one new key', async () => {
        const filePath = path.join(tempDir, 'multi.yml');
        const initialContent = `---
en:
  one:
    Multi-line plain one continues
    onto a second line here.
  two:
    Multi-line plain two also continues
    onto a second line here.
  three:
    Multi-line plain three continues
    onto a second line here too.
  short: short value
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'four': 'a brand new key value'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        const originalLines = initialContent.split('\n').filter(l => l.trim());
        const updatedLines = updated.split('\n').filter(l => l.trim());

        for (const original of originalLines) {
          expect(updatedLines).toContain(original);
        }

        expect(updated).toContain('four: a brand new key value');
      });

      it('produces byte-identical output when no changes are requested', async () => {
        const filePath = path.join(tempDir, 'roundtrip.yml');
        const initialContent = `---
en:
  subject: Before your viewing with %{tenant_name}
  description:
    A quick note ahead of the viewing at %{address}.
    Here are the details you'll need.
  body: |
    Line one of literal block.
    Line two of literal block.
  folded: >
    Folded scalar that spans
    multiple lines.
  quoted_double: "Hello, %{name}!"
  quoted_single: 'It''s a test'
  nested:
    deeply:
      value: leaf
  array:
    - one
    - two
sv:
  subject: Inför visningen
  body: |
    Rad ett.
    Rad två.
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {}, 'en');

        const after = fs.readFileSync(filePath, 'utf8');
        expect(after).toBe(initialContent);
      });

      it('handles deeply nested key insertion', async () => {
        const filePath = path.join(tempDir, 'deep.yml');
        const initialContent = `---
en:
  app: TaskFlow
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'section.subsection.deeply.nested.key': 'deep value'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        expect(updated).toContain('  app: TaskFlow');
        expect(updated).toMatch(/  section:\n {4}subsection:\n {6}deeply:\n {8}nested:\n {10}key: deep value/);
      });

      it('preserves a file without a trailing newline', async () => {
        const filePath = path.join(tempDir, 'no-trailing.yml');
        const initialContent = `en:\n  subject: Hello`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'greeting': 'Welcome'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        expect(updated).toContain('  subject: Hello');
        expect(updated).toContain('  greeting: Welcome');
      });

      it('overwriting a map-valued key with a scalar falls back without corrupting the file', async () => {
        const filePath = path.join(tempDir, 'collision.yml');
        const initialContent = `en:
  buttons:
    submit: Submit
  other: stays
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, { buttons: 'Press me' }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        const buttonsOccurrences = (updated.match(/^ {2}buttons:/gm) || []).length;
        expect(buttonsOccurrences).toBe(1);
        expect(updated).toContain('other: stays');
      });

      it('replacing an existing block literal scalar produces valid YAML', async () => {
        const filePath = path.join(tempDir, 'block-replace.yml');
        const initialContent = `en:
  description: |
    Line one
    Line two
  other: stays
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          description: 'New line one\nNew line two'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');

        expect(updated).toMatch(/description:\s*\|/);
        expect(updated).toContain('New line one');
        expect(updated).toContain('New line two');
        expect(updated).toContain('other: stays');

        const parsed = yaml.parse(updated);
        expect(parsed.en.description).toContain('New line one');
        expect(parsed.en.description).toContain('New line two');
        expect(parsed.en.other).toBe('stays');
      });

      it('inserting multiple keys under a missing locale produces a single merged block', async () => {
        const filePath = path.join(tempDir, 'new-locale.yml');
        const initialContent = `en:
  subject: Hello
  headline: Title
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          subject: 'Hej',
          headline: 'Rubrik'
        }, 'sv');

        const updated = fs.readFileSync(filePath, 'utf8');
        const svBlockCount = (updated.match(/^sv:/gm) || []).length;
        expect(svBlockCount).toBe(1);

        const parsed = yaml.parse(updated);
        expect(parsed.sv.subject).toBe('Hej');
        expect(parsed.sv.headline).toBe('Rubrik');
      });

      it('inserting multiple keys under a missing nested section produces a single merged block', async () => {
        const filePath = path.join(tempDir, 'new-section.yml');
        const initialContent = `en:
  existing: ok
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'section.first': 'A',
          'section.second': 'B'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const sectionBlockCount = (updated.match(/^ {2}section:/gm) || []).length;
        expect(sectionBlockCount).toBe(1);

        const parsed = yaml.parse(updated);
        expect(parsed.en.section.first).toBe('A');
        expect(parsed.en.section.second).toBe('B');
      });

      it('quotes string values that YAML would otherwise re-parse as non-strings', async () => {
        const filePath = path.join(tempDir, 'type-safe.yml');
        const initialContent = `en:
  existing: ok
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          numeric: '123',
          truthy: 'true',
          nully: 'null',
          empty: ''
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);
        expect(parsed.en.numeric).toBe('123');
        expect(parsed.en.truthy).toBe('true');
        expect(parsed.en.nully).toBe('null');
        expect(parsed.en.empty).toBe('');
      });

      it('updating an existing key with a string that looks numeric preserves string type', async () => {
        const filePath = path.join(tempDir, 'numeric-update.yml');
        const initialContent = `en:
  zip_code: "12345"
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, { zip_code: '99999' }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);
        expect(parsed.en.zip_code).toBe('99999');
        expect(typeof parsed.en.zip_code).toBe('string');
      });

      it('replacing a single-line scalar with a multi-line value indents continuation lines correctly', async () => {
        const filePath = path.join(tempDir, 'multiline-indent.yml');
        const initialContent = `en:
  desc: short
  other: keep
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          desc: 'long\nmulti\nline'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);
        expect(parsed.en.desc).toBe('long\nmulti\nline');
        expect(parsed.en.other).toBe('keep');

        const lines = updated.split('\n');
        const continuationLines = lines.filter(l => /^ +(long|multi|line)$/.test(l));
        expect(continuationLines.length).toBe(3);
        for (const line of continuationLines) {
          const leadingSpaces = line.match(/^ +/)[0].length;
          expect(leadingSpaces).toBe(4);
        }
      });
    });

    describe('empty-key writing', () => {
      it('inserts a space when filling a key that existed with an empty value', async () => {
        const filePath = path.join(tempDir, 'devise.views.id.yml');
        const initialContent = `id:
  devise:
    sessions:
      already_signed_out:
      new:
        sign_in: Masuk
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'devise.sessions.already_signed_out': 'Keluar dari akun berhasil.'
        }, 'id');

        const updated = fs.readFileSync(filePath, 'utf8');

        expect(updated).toContain('already_signed_out: Keluar dari akun berhasil.');
        expect(updated).not.toContain('already_signed_out:Keluar');

        const reparsed = yaml.parse(updated);
        expect(reparsed.id.devise.sessions.already_signed_out).toBe('Keluar dari akun berhasil.');
        expect(reparsed.id.devise.sessions.new.sign_in).toBe('Masuk');
      });

      it('preserves an inline comment when filling an empty key', async () => {
        const filePath = path.join(tempDir, 'commented.yml');
        const initialContent = `en:
  greeting: # please translate
  other: value
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, { 'greeting': 'Hello' }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const reparsed = yaml.parse(updated);

        expect(reparsed.en.greeting).toBe('Hello');
        expect(updated).toContain('# please translate');
      });
    });

    describe('scalar-to-plural migration', () => {
      it('preserves the original flat value as .other when nesting a plural category under it', async () => {
        const filePath = path.join(tempDir, 'ja.yml');
        const initialContent = `ja:
  category_card:
    sr:
      show_description: '概要'
    lessons_count: '%{count}レッスン'
    select: '詳細を見る'
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'category_card.lessons_count.zero': 'レッスンなし'
        }, 'ja');

        const updated = fs.readFileSync(filePath, 'utf8');
        const reparsed = yaml.parse(updated);

        expect(reparsed.ja.category_card.lessons_count.other).toBe('%{count}レッスン');
        expect(reparsed.ja.category_card.lessons_count.zero).toBe('レッスンなし');
        expect(reparsed.ja.category_card.select).toBe('詳細を見る');
      });

      it('preserves an existing sequence value as .other when nesting a plural category', async () => {
        const filePath = path.join(tempDir, 'seq.yml');
        const initialContent = `en:
  count:
    - one
    - two
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, { 'count.zero': 'None' }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const reparsed = yaml.parse(updated);

        expect(reparsed.en.count.other).toEqual(['one', 'two']);
        expect(reparsed.en.count.zero).toBe('None');
      });

      it('does not invent .other when a plural-category name is a non-terminal path segment', async () => {
        const filePath = path.join(tempDir, 'settings.yml');
        const initialContent = `en:
  settings: old value
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'settings.one.label': 'A label'
        }, 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const reparsed = yaml.parse(updated);

        expect(reparsed.en.settings.other).toBeUndefined();
        expect(reparsed.en.settings.one.label).toBe('A label');
      });
    });

    describe('multi-key deletion safety', () => {
      it('deleting all children of a nested map removes the parent without losing siblings', async () => {
        const filePath = path.join(tempDir, 'multi-delete.yml');
        const initialContent = `en:
  section:
    first: A
    second: B
  keep: ok
`;
        fs.writeFileSync(filePath, initialContent);

        await deleteKeysFromTranslationFile(filePath, ['section.first', 'section.second'], 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);

        expect(parsed.en.section).toBeUndefined();
        expect(parsed.en.keep).toBe('ok');
      });

      it('deleting two siblings of a nested map preserves remaining children', async () => {
        const filePath = path.join(tempDir, 'partial-delete.yml');
        const initialContent = `en:
  section:
    first: A
    second: B
    survivor: keep
`;
        fs.writeFileSync(filePath, initialContent);

        await deleteKeysFromTranslationFile(filePath, ['section.first', 'section.second'], 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);

        expect(parsed.en.section.first).toBeUndefined();
        expect(parsed.en.section.second).toBeUndefined();
        expect(parsed.en.section.survivor).toBe('keep');
      });

      it('deleting non-adjacent sibling keys preserves keys between them', async () => {
        const filePath = path.join(tempDir, 'non-adjacent-delete.yml');
        const initialContent = `en:
  a: 1
  b: 2
  c: 3
  d: 4
`;
        fs.writeFileSync(filePath, initialContent);

        await deleteKeysFromTranslationFile(filePath, ['a', 'c'], 'en');

        const updated = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(updated);

        expect(parsed.en.a).toBeUndefined();
        expect(parsed.en.b).toBe(2);
        expect(parsed.en.c).toBeUndefined();
        expect(parsed.en.d).toBe(4);
      });
    });

    describe('array handling', () => {
      it('formats arrays with proper YAML syntax', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'company.address': ['Street 123', 'Floor 4', '12345 City'],
          'categories': ['A', 'B', 'C']
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        expect(content).toMatch(/en:\n {2}company:\n {4}address:\n {6}- Street 123\n {6}- Floor 4\n {6}- 12345 City/);
        expect(content).toMatch(/ {2}categories:\n {4}- A\n {4}- B\n {4}- C/);
      });

      it('properly quotes array items with special characters', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'items': ['Item with %{var}', 'Item with "quotes"', 'Regular item']
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        expect(content).toMatch(/en:\n {2}items:\n {4}- "Item with %{var}"\n {4}- Item with "quotes"\n {4}- Regular item/);
      });

      it('parses JSON array strings from API response', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'app.the_array': '["First element", "Second element", "Third element"]',
          'app.another_array': '["Item with %{var}", "Item with quotes", "Regular item"]'
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        expect(content).toMatch(/en:\n {2}app:\n {4}the_array:\n {6}- First element\n {6}- Second element\n {6}- Third element/);
        expect(content).toMatch(/ {4}another_array:\n {6}- "Item with %{var}"\n {6}- Item with quotes\n {6}- Regular item/);
      });

      it('handles invalid JSON array strings gracefully', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const translations = {
          'app.invalid_array': '["Broken JSON string'
        };

        await updateTranslationFile(filePath, translations, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        // The yaml library escapes and quotes the broken string
        expect(content).toContain('invalid_array:');
        // Just check that the content is preserved in some form
        expect(content).toMatch(/\[.*Broken JSON string/);
      });

      it('preserves array item quote styles when updating', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const initialContent = `
en:
  company:
    address:
      - "Andersson-Larsson Holding AB"
      - "3B Jösseforsvägen"
      - "122 47, Stockholm, Sweden"
    categories:
      - Basic
      - "Premium & Gold"
      - Pro
`;
        fs.writeFileSync(filePath, initialContent);

        // Update with new values but same structure
        await updateTranslationFile(filePath, {
          'company.address': ['New Company AB', '5C Storgatan', '123 45, Gothenburg, Sweden'],
          'company.categories': ['Basic', 'Premium & Gold', 'Pro']
        }, 'en');

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('en:');
        // Special character items should be quoted
        expect(content).toContain('"123 45, Gothenburg, Sweden"');
        expect(content).toContain('"Premium & Gold"');
        // Regular items may not be quoted, but that's fine as they don't need quotes
        expect(content).toContain('- Basic');
        expect(content).toContain('- Pro');
      });

      it('preserves comments when updating YAML files', async () => {
        const filePath = path.join(tempDir, 'en.yml');
        const initialContent = `
# Main language file
en:
  # Section for all button texts
  buttons:
    submit: "Submit" # Main submit button
    cancel: "Cancel" # Cancel button
  # User messages section
  messages:
    welcome: "Welcome" # Greeting message
`;
        fs.writeFileSync(filePath, initialContent);

        await updateTranslationFile(filePath, {
          'buttons.submit': 'Save',
          'messages.welcome': 'Hello'
        });

        const content = fs.readFileSync(filePath, 'utf8');

        // Main comment should be preserved
        expect(content).toContain('# Main language file');
        // Section comments should be preserved
        expect(content).toContain('# Section for all button texts');
        expect(content).toContain('# User messages section');
        expect(content).toContain('submit: "Save"');
        expect(content).toContain('welcome: "Hello"');

        // Check for comment presence (the yaml library might move inline comments)
        // Note: Sometimes the yaml library might move inline comments to their own lines
        const hasSubmitButtonComment = content.includes('# Main submit button');
        const hasGreetingComment = content.includes('# Greeting message');
        const hasCancelButtonComment = content.includes('# Cancel button');

        expect(hasSubmitButtonComment || hasGreetingComment || hasCancelButtonComment).toBe(true);
      });
    });

    describe('handling malformed YAML files', () => {
      it('handles files with only language code', async () => {
        const filePath = path.join(tempDir, 'nb.yml');
        fs.writeFileSync(filePath, 'nb:');

        const translations = {
          'greeting': 'Hei',
          'message': 'Velkommen'
        };

        const result = await updateTranslationFile(filePath, translations, 'nb');

        expect(result).toEqual({
          updatedKeys: ['greeting', 'message'],
          created: false
        });

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('nb:');
        expect(content).toContain('greeting: Hei');
        expect(content).toContain('message: Velkommen');
      });

      it('handles files with undefined language node', async () => {
        const filePath = path.join(tempDir, 'nb.yml');
        fs.writeFileSync(filePath, 'nb:  # Empty language node');

        const translations = {
          'greeting': 'Hei'
        };

        const result = await updateTranslationFile(filePath, translations, 'nb');

        expect(result).toEqual({
          updatedKeys: ['greeting'],
          created: false
        });

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('nb:');
        expect(content).toContain('greeting: Hei');
      });

      it('handles files with null language node', async () => {
        const filePath = path.join(tempDir, 'nb.yml');
        fs.writeFileSync(filePath, 'nb: null');

        const translations = {
          'greeting': 'Hei'
        };

        const result = await updateTranslationFile(filePath, translations, 'nb');

        expect(result).toEqual({
          updatedKeys: ['greeting'],
          created: false
        });

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('nb:');
        expect(content).toContain('greeting: Hei');
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

  describe('duplicate YAML keys', () => {
    it('updates YAML files with duplicate keys without crashing', async () => {
      const filePath = path.join(tempDir, 'de.yml');
      const yamlWithDuplicates = [
        'de:',
        '  translation:',
        '    greeting: "Hallo"',
        '    farewell: "Tschüss"',
        '    greeting: "Hallo Welt"',
        ''
      ].join('\n');
      fs.writeFileSync(filePath, yamlWithDuplicates);

      const result = await updateTranslationFile(filePath, { 'translation.farewell': 'Auf Wiedersehen' }, 'de');

      expect(result.updatedKeys).toEqual(['translation.farewell']);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('Auf Wiedersehen');
    });

    it('does not write null target values as the literal string "null" in .po files', async () => {
      const sourceFilePath = path.join(tempDir, 'source.po');
      const sourceContent = [
        'msgid ""',
        'msgstr ""',
        '"Content-Type: text/plain; charset=UTF-8\\n"',
        '',
        'msgid "hello"',
        'msgstr "Hello"',
        '',
        'msgid "goodbye"',
        'msgstr "Goodbye"',
        ''
      ].join('\n');
      fs.writeFileSync(sourceFilePath, sourceContent);

      const targetFilePath = path.join(tempDir, 'target.po');
      // Mixed payload: one translated key, one still awaiting (null).
      const translations = {
        hello: 'Hej',
        goodbye: null
      };

      await updateTranslationFile(targetFilePath, translations, 'sv', sourceFilePath);

      const targetContent = fs.readFileSync(targetFilePath, 'utf8');
      expect(targetContent).toContain('msgstr "Hej"');
      expect(targetContent).not.toContain('msgstr "null"');
    });

    it('deletes keys from YAML files with duplicate keys without crashing', async () => {
      const filePath = path.join(tempDir, 'sv.yml');
      const yamlWithDuplicates = [
        'sv:',
        '  section:',
        '    keep_me: "Behåll"',
        '    remove_me: "Ta bort"',
        '    keep_me: "Behåll igen"',
        ''
      ].join('\n');
      fs.writeFileSync(filePath, yamlWithDuplicates);

      const deleted = await deleteKeysFromTranslationFile(filePath, ['section.remove_me'], 'sv');

      expect(deleted).toEqual(['section.remove_me']);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).not.toContain('remove_me');
    });
  });
});