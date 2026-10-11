import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import { updateYamlFile } from '../../../src/utils/translation-updater/yaml-handler.js';

describe('keeping the plural shape a YAML file already has (localheroai/localhero-ai#916)', () => {
  let tempDir: string;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhero-test-'));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    warn.mockRestore();
  });

  function writeFile(name: string, lines: string[]): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, lines.join('\n'));
    return filePath;
  }

  function writeEnglishSource(): string {
    return writeFile('en.yml', [
      'en:',
      '  lessons:',
      '    flat_one:',
      '      one: "%{count} lesson"',
      '      other: "%{count} lessons"',
      '    nested_one:',
      '      one: "%{count} lesson"',
      '      other: "%{count} lessons"',
      '    title: Lessons',
      ''
    ]);
  }

  it('writes an incoming .other into a flat plural, changing only its value', async () => {
    const original = [
      '# Lessons',
      'ja:',
      '  lessons:',
      '    flat_one: "古い %{count}"  # other only',
      '',
      '    title: \'レッスン\'',
      ''
    ];
    const filePath = writeFile('ja.yml', original);

    await updateYamlFile(filePath, { 'lessons.flat_one.other': '新しい %{count}' }, 'ja', writeEnglishSource(), 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      original.join('\n').replace('"古い %{count}"', '"新しい %{count}"')
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes an incoming .other into an empty flat plural, keeping it flat', async () => {
    const filePath = writeFile('ja.yml', ['ja:', '  lessons:', '    flat_one:', '    title: レッスン', '']);

    await updateYamlFile(filePath, { 'lessons.flat_one.other': '新しい %{count}' }, 'ja', writeEnglishSource(), 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      'ja:\n  lessons:\n    flat_one: 新しい %{count}\n    title: レッスン\n'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes an incoming flat value into the .other of a nested plural, leaving one untouched', async () => {
    const original = [
      'de:',
      '  lessons:',
      '    nested_one:',
      '      # singular',
      '      one: \'Alte Lektion\'',
      '      other: "Alte %{count}"',
      '    title: Lektionen',
      ''
    ];
    const filePath = writeFile('de.yml', original);

    await updateYamlFile(filePath, { 'lessons.nested_one': 'Neue %{count}' }, 'de', writeEnglishSource(), 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      original.join('\n').replace('"Alte %{count}"', '"Neue %{count}"')
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes a new key in the shape it arrives in', async () => {
    const filePath = writeFile('ja.yml', ['ja:', '  lessons:', '    title: レッスン', '']);

    await updateYamlFile(filePath, {
      'lessons.nested_new.other': '%{count} 件',
      'lessons.flat_new': '%{count} 個'
    }, 'ja', writeEnglishSource(), 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe([
      'ja:',
      '  lessons:',
      '    title: レッスン',
      '    nested_new:',
      '      other: "%{count} 件"',
      '    flat_new: "%{count} 個"',
      ''
    ].join('\n'));
  });

  it('still nests a flat plural that receives several forms', async () => {
    const filePath = writeFile('de.yml', ['de:', '  lessons:', '    flat_one: "%{count} Lektionen"', '']);

    await updateYamlFile(filePath, {
      'lessons.flat_one.one': 'Eine Lektion',
      'lessons.flat_one.other': '%{count} Lektionen neu'
    }, 'de', writeEnglishSource(), 'en');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.de.lessons.flat_one).toEqual({ one: 'Eine Lektion', other: '%{count} Lektionen neu' });
  });

  it('does not treat a map with non-plural children as a plural', async () => {
    const filePath = writeFile('de.yml', ['de:', '  errors:', '    title: Fehler', '    other: Andere', '']);

    await updateYamlFile(filePath, { errors: 'Ein Fehler' }, 'de');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.de.errors).toBe('Ein Fehler');
  });

  it('does not treat a namespace with category-named sections as a plural', async () => {
    const sourcePath = writeFile('en.yml', ['en:', '  errors:', '    one: An error', '    other: Errors', '']);
    const filePath = writeFile('de.yml', [
      'de:',
      '  errors:',
      '    one:',
      '      title: Ein Fehler',
      '    other:',
      '      title: Fehler',
      ''
    ]);

    await updateYamlFile(filePath, { errors: 'Fehler' }, 'de', sourcePath, 'en');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.de.errors).toBe('Fehler');
  });

  it('does not collapse a lone .other the source does not hold as a plural', async () => {
    const sourcePath = writeFile('en.yml', ['en:', '  errors:', '    other: Other error', '']);
    const filePath = writeFile('de.yml', ['de:', '  errors: Fehler', '']);

    await updateYamlFile(filePath, { 'errors.other': 'Anderer Fehler' }, 'de', sourcePath, 'en');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.de.errors).toEqual({ other: 'Anderer Fehler' });
  });

  it('does not write a flat value into .other when the source holds the key flat', async () => {
    const sourcePath = writeFile('en.yml', ['en:', '  errors: Error', '']);
    const filePath = writeFile('de.yml', ['de:', '  errors:', '    other: Andere', '']);

    await updateYamlFile(filePath, { errors: 'Fehler' }, 'de', sourcePath, 'en');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.de.errors).toBe('Fehler');
  });

  it('reads a source file that repeats a key, as Rails does', async () => {
    const sourcePath = writeFile('en.yml', [
      'en:',
      '  title: Lessons',
      '  title: Courses',
      '  count:',
      '    one: "%{count} lesson"',
      '    other: "%{count} lessons"',
      ''
    ]);
    const filePath = writeFile('ja.yml', ['ja:', '  count: "古い %{count}"', '']);

    await updateYamlFile(filePath, { 'count.other': '新しい %{count}' }, 'ja', sourcePath, 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('ja:\n  count: "新しい %{count}"\n');
  });

  it('writes a flat value into a plural whose own key is named other', async () => {
    const sourcePath = writeFile('en.yml', ['en:', '  messages:', '    other:', '      one: One other', '      other: Others', '']);
    const original = ['de:', '  messages:', '    other:', '      one: Ein anderer', '      other: Andere', ''];
    const filePath = writeFile('de.yml', original);

    await updateYamlFile(filePath, { 'messages.other': 'Weitere' }, 'de', sourcePath, 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(original.join('\n').replace('other: Andere', 'other: Weitere'));
  });

  it('keeps writing as the keys arrive when no source file is known', async () => {
    const filePath = writeFile('ja.yml', ['ja:', '  lessons:', '    flat_one: "古い %{count}"', '']);

    await updateYamlFile(filePath, { 'lessons.flat_one.other': '新しい %{count}' }, 'ja');

    const reparsed = yaml.parse(fs.readFileSync(filePath, 'utf8'));
    expect(reparsed.ja.lessons.flat_one).toEqual({ other: '新しい %{count}' });
  });

  it('keeps each locale root in its own shape in a multi-language file', async () => {
    const original = [
      'en:',
      '  lessons:',
      '    count:',
      '      one: "%{count} lesson"',
      '      other: "%{count} lessons"',
      'ja:',
      '  lessons:',
      '    count: "%{count} レッスン"',
      'de:',
      '  lessons:',
      '    count:',
      '      one: "Eine Lektion"',
      '      other: "%{count} Lektionen"',
      ''
    ];
    const filePath = writeFile('lessons.yml', original);

    await updateYamlFile(filePath, { 'lessons.count.other': '%{count} 件のレッスン' }, 'ja', filePath, 'en');
    await updateYamlFile(filePath, { 'lessons.count': '%{count} neue Lektionen' }, 'de', filePath, 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      original.join('\n')
        .replace('"%{count} レッスン"', '"%{count} 件のレッスン"')
        .replace('"%{count} Lektionen"', '"%{count} neue Lektionen"')
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the shape of plurals nested several levels deep', async () => {
    const sourcePath = writeFile('en.yml', [
      'en:',
      '  courses:',
      '    sections:',
      '      lessons:',
      '        flat_one:',
      '          one: "%{count} lesson"',
      '          other: "%{count} lessons"',
      '        nested_one:',
      '          one: "%{count} lesson"',
      '          other: "%{count} lessons"',
      ''
    ]);
    const filePath = writeFile('ja.yml', [
      'ja:',
      '  courses:',
      '    sections:',
      '      lessons:',
      '        flat_one: "古い %{count}"',
      '        nested_one:',
      '          other: "古い %{count}"',
      ''
    ]);

    await updateYamlFile(filePath, {
      'courses.sections.lessons.flat_one.other': '新しい平ら %{count}',
      'courses.sections.lessons.nested_one': '新しい入れ子 %{count}'
    }, 'ja', sourcePath, 'en');

    expect(fs.readFileSync(filePath, 'utf8')).toBe([
      'ja:',
      '  courses:',
      '    sections:',
      '      lessons:',
      '        flat_one: "新しい平ら %{count}"',
      '        nested_one:',
      '          other: "新しい入れ子 %{count}"',
      ''
    ].join('\n'));
    expect(warn).not.toHaveBeenCalled();
  });
});
