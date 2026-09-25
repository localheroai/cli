import { describe, it, expect } from '@jest/globals';
import { keyLineFinder } from '../../src/utils/key-lines.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function findKeyLine(content: string, format: string, key: string, locale?: string): number | null {
  return keyLineFinder(content, format, locale)(key);
}

describe('findKeyLine', () => {
  describe('yaml', () => {
    const wrapped = lines(
      'sv:',
      '  dashboard:',
      '    title: Översikt',
      '    welcome: Hej',
      '  empty:',
      "  'NO': Nej",
      '  days:',
      '    - Mån',
      '    - Tis'
    );

    it('finds a nested key below the locale wrapper', () => {
      expect(findKeyLine(wrapped, 'yml', 'dashboard.welcome', 'sv')).toBe(4);
    });

    it('finds a nested key in a file without a locale wrapper', () => {
      expect(findKeyLine(lines('dashboard:', '  title: A', '  welcome: B'), 'yaml', 'dashboard.welcome')).toBe(3);
    });

    it('returns null for a missing key', () => {
      expect(findKeyLine(wrapped, 'yml', 'dashboard.missing', 'sv')).toBeNull();
    });

    it('finds a key whose value is empty', () => {
      expect(findKeyLine(wrapped, 'yml', 'empty', 'sv')).toBe(5);
    });

    it('finds a quoted key', () => {
      expect(findKeyLine(wrapped, 'yml', 'NO', 'sv')).toBe(6);
    });

    it('finds the key holding an array', () => {
      expect(findKeyLine(wrapped, 'yml', 'days', 'sv')).toBe(7);
    });

    it('picks the subtree for the locale in a multi-language file', () => {
      const content = lines('en:', '  greeting: Hi', 'sv:', '  greeting: Hej');
      expect(findKeyLine(content, 'yml', 'greeting', 'sv')).toBe(4);
    });

    it('finds a key that contains a dot', () => {
      expect(findKeyLine(lines('sv:', '  errors:', '    "not.found": Saknas'), 'yml', 'errors.not.found', 'sv')).toBe(3);
    });

    it('returns null when a dotted key and a nested path both match', () => {
      const content = lines('sv:', '  "a.b": X', '  a:', '    b: Y');
      expect(findKeyLine(content, 'yml', 'a.b', 'sv')).toBeNull();
    });

    it('points at the last of duplicated keys, the one that is loaded', () => {
      expect(findKeyLine(lines('sv:', '  a: Gammal', '  a: Ny'), 'yml', 'a', 'sv')).toBe(3);
    });

    it('returns null for invalid yaml', () => {
      expect(findKeyLine(lines('sv:', '  a: [unclosed'), 'yml', 'a', 'sv')).toBeNull();
    });
  });

  describe('json', () => {
    it('finds a nested key below the locale wrapper', () => {
      const content = lines('{', '  "sv": {', '    "dashboard": {', '      "welcome": "Hej"', '    }', '  }', '}');
      expect(findKeyLine(content, 'json', 'dashboard.welcome', 'sv')).toBe(4);
    });

    it('finds a flat dotted key', () => {
      const content = lines('{', '  "dashboard.title": "A",', '  "dashboard.welcome": "B"', '}');
      expect(findKeyLine(content, 'json', 'dashboard.welcome')).toBe(3);
    });

    it('returns null for a missing key', () => {
      expect(findKeyLine(lines('{', '  "a": "A"', '}'), 'json', 'b')).toBeNull();
    });

    it('finds an i18next plural key after values with escapes', () => {
      const content = lines('{', '  "quote": "Say \\"hi\\" {\\n}",', '  "item_one": "{{count}} item"', '}');
      expect(findKeyLine(content, 'json', 'item_one')).toBe(3);
    });

    it('returns null for invalid json', () => {
      expect(findKeyLine(lines('{', '  "a": "A",', '}'), 'json', 'a')).toBeNull();
    });
  });

  describe('po', () => {
    const content = lines(
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '',
      'msgid "Hello"',
      'msgstr "Hej"',
      '',
      'msgctxt "menu"',
      'msgid "Open"',
      'msgstr "Öppna"',
      '',
      'msgid ""',
      '"A long \\"quoted\\" "',
      '"text\\n"',
      'msgstr ""',
      '',
      'msgid "One file"',
      'msgid_plural "%d files"',
      'msgstr[0] "En fil"',
      'msgstr[1] "%d filer"',
      '',
      '#~ msgid "Old"',
      '#~ msgstr "Gammal"'
    );

    it('finds the msgid line of a plain entry', () => {
      expect(findKeyLine(content, 'po', 'Hello')).toBe(5);
    });

    it('finds the msgid line of an entry with context', () => {
      expect(findKeyLine(content, 'po', 'menu|Open')).toBe(9);
    });

    it('finds a multi-line msgid with escaped characters', () => {
      expect(findKeyLine(content, 'pot', 'A long "quoted" text\n')).toBe(12);
    });

    it('points plural suffix keys at the entry', () => {
      expect(findKeyLine(content, 'po', 'One file__plural_1')).toBe(17);
    });

    it('returns null for a missing key and for obsolete entries', () => {
      expect(findKeyLine(content, 'po', 'Missing')).toBeNull();
      expect(findKeyLine(content, 'po', 'Old')).toBeNull();
    });
  });

  it('returns null for an unknown format', () => {
    expect(findKeyLine('a = b\n', 'properties', 'a')).toBeNull();
  });

  it('parses once and answers many keys with keyLineFinder', () => {
    const lineOf = keyLineFinder(lines('sv:', '  a: A', '  b: B'), 'yml', 'sv');
    expect([lineOf('a'), lineOf('b'), lineOf('c')]).toEqual([2, 3, null]);
  });
});
