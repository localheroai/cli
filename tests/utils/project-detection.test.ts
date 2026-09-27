import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { detectProjectType, filePatternForDirectory } from '../../src/utils/project-detection.js';

describe('detectProjectType', () => {
  let dir: string;
  const originalCwd = process.cwd();

  function write(file: string, content = '{}') {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }

  function packageJson(dependencies: Record<string, string>) {
    write('package.json', JSON.stringify({ dependencies }));
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'project-detection-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects a Rails app from config/application.rb', async () => {
    write('config/application.rb', '');
    write('Gemfile', '');
    write('config/locales/en.yml', 'en:\n  hello: Hello\n');

    const result = await detectProjectType();

    expect(result.type).toBe('rails');
    expect(result.defaults.translationPath).toBe('config/locales/');
  });

  it('does not treat a React Native app as Rails because of its Gemfile', async () => {
    write('Gemfile', "source 'https://rubygems.org'\n");
    packageJson({ 'react-native': '0.81.0', i18next: '25.0.0', 'react-i18next': '15.0.0' });
    write('src/locales/en/translation.json');

    const result = await detectProjectType();

    expect(result.type).toBe('i18next');
    expect(result.defaults.translationPath).toBe('src/locales/');
    expect(result.defaults.filePattern).toBe('**/*.json');
  });

  it('still finds YAML locales in a Ruby project without config/application.rb', async () => {
    write('Gemfile', '');
    write('config/locales/en.yml', 'en:\n  hello: Hello\n');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('config/locales/');
    expect(result.defaults.filePattern).toBe('**/*.{yml,yaml}');
  });

  it('finds app/i18n/locales in a Next.js App Router project using i18next', async () => {
    write('next.config.js', '');
    packageJson({ next: '15.0.0', i18next: '25.0.0', 'react-i18next': '15.0.0' });
    write('app/i18n/locales/en/translation.json');

    const result = await detectProjectType();

    expect(result.type).toBe('i18next');
    expect(result.defaults.translationPath).toBe('app/i18n/locales/');
  });

  it('still detects a next-i18next project', async () => {
    write('next.config.js', '');
    packageJson({ next: '14.0.0', 'next-i18next': '15.0.0', i18next: '23.0.0' });
    write('public/locales/en/common.json');

    const result = await detectProjectType();

    expect(result.type).toBe('nextjs');
    expect(result.defaults.translationPath).toBe('public/locales/');
  });

  it('prefers src/i18n/locales over the wider src/i18n', async () => {
    packageJson({ i18next: '25.0.0' });
    write('src/i18n/index.ts', '');
    write('src/i18n/locales/en/translation.json');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('src/i18n/locales/');
  });

  it('reads the output directory from an i18next-cli config', async () => {
    packageJson({ i18next: '25.0.0' });
    write('i18next.config.ts', `import { defineConfig } from 'i18next-cli';
export default defineConfig({
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'shared/translations/{{language}}/{{namespace}}.json'
  }
});
`);
    write('shared/translations/en/common.json');
    write('public/locales/en/common.json');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('shared/translations/');
  });

  it('reads the output directory from an i18next-parser config', async () => {
    packageJson({ i18next: '23.0.0' });
    write('i18next-parser.config.js', "module.exports = {\n  output: 'assets/i18n/$LOCALE/$NAMESPACE.json',\n};\n");
    write('assets/i18n/en/translation.json');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('assets/i18n/');
  });

  it('ignores a commented-out output line in the config', async () => {
    packageJson({ i18next: '23.0.0' });
    write('i18next-parser.config.js', "module.exports = {\n  // output: 'old/$LOCALE/$NAMESPACE.json',\n  output: 'locales/$LOCALE/$NAMESPACE.json',\n};\n");
    write('old/en/translation.json');
    write('locales/en/translation.json');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('locales/');
  });

  it('falls back to common paths when the configured output directory does not exist', async () => {
    packageJson({ i18next: '25.0.0' });
    write('i18next.config.ts', "export default { extract: { output: 'missing/{{language}}/{{namespace}}.json' } };\n");
    write('public/locales/en/common.json');

    const result = await detectProjectType();

    expect(result.defaults.translationPath).toBe('public/locales/');
  });

  describe('filePatternForDirectory', () => {
    it('includes .pot templates next to .po catalogs', async () => {
      write('translations/messages.pot', '');
      write('translations/sv/LC_MESSAGES/messages.po', '');

      expect(await filePatternForDirectory('translations/')).toBe('**/*.{po,pot}');
    });

    it('returns null for a directory without translation files', async () => {
      write('empty/readme.txt', '');

      expect(await filePatternForDirectory('empty/')).toBeNull();
    });
  });
});
