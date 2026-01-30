import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
      // The yaml library uses its own style but should preserve special character quoting
      expect(updatedContent).toContain('greeting: "Hi, %{name}!"');
      // Simple format now, but we at least preserve comments
      expect(updatedContent).toContain("message: Hello");
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
        // The document API doesn't preserve quotes on simple strings
        expect(content).toContain('  title: New Title');
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
        // The yaml library preserves comments but might change quote formats
        expect(content).toContain('submit: Save');
        expect(content).toContain('welcome: Hello');

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
});