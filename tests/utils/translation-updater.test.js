import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateTranslationFile } from '../../src/utils/translation-updater.js';

describe('translation-updater', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('updateTranslationFile', () => {
        test('preserves existing quote styles in YAML files', async () => {
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

        test('adds quotes for values with special characters', async () => {
            const filePath = path.join(tempDir, 'en.yml');
            await updateTranslationFile(filePath, {
                'special': 'Contains: special, characters!',
                'normal': 'plain text'
            });

            const content = fs.readFileSync(filePath, 'utf8');
            expect(content).toContain('special: "Contains: special, characters!"');
            expect(content).toContain('normal: plain text');
        });

        test('handles nested structures correctly', async () => {
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

        test('preserves existing content structure', async () => {
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

        test('handles errors gracefully', async () => {
            const filePath = path.join(tempDir, 'nonexistent', 'en.yml');
            const updates = { 'key': 'value' };

            await expect(updateTranslationFile(filePath, updates))
                .resolves
                .toEqual(['key']);
        });
    });
}); 