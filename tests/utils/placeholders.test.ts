import { describe, it, expect } from '@jest/globals';
import { extractPlaceholders, placeholderMultiset, reduceIcuComplexArguments, spellPlaceholders } from '../../src/utils/placeholders.js';

describe('extractPlaceholders', () => {
  it('extracts i18next/Vue/Angular double-brace placeholders', () => {
    expect(extractPlaceholders('Hello {{name}}')).toEqual([{ kind: 'i18next', name: 'name' }]);
  });

  it('does not double-count {{name}} as an ICU single-brace placeholder', () => {
    const found = extractPlaceholders('Hello {{name}}');
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('i18next');
  });

  it('extracts ICU/react-intl single-brace placeholders', () => {
    expect(extractPlaceholders('Hello {name}')).toEqual([{ kind: 'icu', name: 'name' }]);
  });

  it('extracts Rails %{name} and %<name>s', () => {
    expect(extractPlaceholders('%{count} items')).toEqual([{ kind: 'rails', name: 'count' }]);
    expect(extractPlaceholders('%<count>s items')).toEqual([{ kind: 'rails-typed', name: 'count' }]);
  });

  it('extracts printf %s %d and positional %1$s', () => {
    expect(extractPlaceholders('%s of %d')).toEqual([
      { kind: 'printf', name: 's' },
      { kind: 'printf', name: 'd' }
    ]);
    // The index is what a translator may change, so only the conversion type is kept.
    expect(extractPlaceholders('%1$s of %2$s')).toEqual([
      { kind: 'positional', name: 's' },
      { kind: 'positional', name: 's' }
    ]);
  });

  it('extracts Python %(name)s', () => {
    expect(extractPlaceholders('%(name)s')).toEqual([{ kind: 'python', name: 'name' }]);
  });

  it('does not treat a literal percent sign followed by a space as a directive', () => {
    expect(extractPlaceholders('Save 10% off')).toEqual([]);
    expect(extractPlaceholders('100%')).toEqual([]);
  });

  it('extracts unescaped and formatted i18next placeholders by name', () => {
    expect(extractPlaceholders('Hi {{- name}}')).toEqual([{ kind: 'i18next', name: 'name' }]);
    expect(extractPlaceholders('{{val, number}} items')).toEqual([{ kind: 'i18next', name: 'val' }]);
  });

  it('returns nothing for a plain string with no placeholders', () => {
    expect(extractPlaceholders('Hello world')).toEqual([]);
  });
});

describe('placeholderMultiset', () => {
  it('counts repeated placeholders', () => {
    const counts = placeholderMultiset('%{name} and %{name} again');
    expect(counts.get('rails:name')).toBe(2);
  });
});

const tokens = (text: string) => [...placeholderMultiset(text).keys()].sort();

describe('ICU complex arguments', () => {
  it('ignores literal branch text in select messages', () => {
    const source = '{gender, select, male {He} female {She} other {They}}';
    const target = '{gender, select, male {Han} female {Hon} other {De}}';
    expect(tokens(source)).toEqual(tokens(target));
    expect(tokens(source)).toEqual(['icu:gender']);
  });

  it('still sees a renamed plural argument', () => {
    expect(tokens('{count, plural, one {# item} other {# items}}')).toEqual(['icu:count']);
    expect(tokens('{antal, plural, one {# vara} other {# varor}}')).toEqual(['icu:antal']);
  });

  it('still sees a placeholder outside the plural', () => {
    expect(tokens('%{user}: {count, plural, other {# items}}')).toEqual(['icu:count', 'rails:user']);
    expect(tokens('{count, plural, other {# varor}}')).toEqual(['icu:count']);
  });

  it('reduces a complex argument to its bare name', () => {
    expect(reduceIcuComplexArguments('{count, plural, one {# item} other {# items}}')).toBe('{count}');
  });
});

describe('printf directives', () => {
  it('treats a renumbered positional argument as the same placeholder', () => {
    expect(tokens('%i from %s:%i via %s')).toEqual(tokens('%1$i via %4$s from %2$s:%3$i'));
  });

  it('still distinguishes conversion types', () => {
    expect(tokens('%d')).not.toEqual(tokens('%1$s'));
  });

  it('reads a directive immediately followed by a word', () => {
    expect(tokens('%g %sbyte(s)')).toEqual(tokens('%g %sbytes'));
  });

  it('does not read a percent glued to a number as a directive', () => {
    expect(tokens('Save 5%discount')).toEqual([]);
    expect(tokens('%d%s done')).toEqual(['printf:d', 'printf:s']);
  });

  it('ignores an escaped percent', () => {
    expect(tokens('100%% sure')).toEqual([]);
    expect(tokens('50% off')).toEqual([]);
  });
});

describe('spellPlaceholders', () => {
  it('writes tokens the way the text writes them', () => {
    expect(spellPlaceholders(['rails:name', 'rails-typed:count'], 'Hi %{name}, %<count>d left')).toEqual(['%{name}', '%<count>d']);
    expect(spellPlaceholders(['i18next:name', 'icu:n', 'python:x'], '{{ name }} {n} %(x)s')).toEqual(['{{ name }}', '{n}', '%(x)s']);
  });

  it('writes a renumbered printf token as the text numbers it', () => {
    expect(spellPlaceholders(['printf:s'], '%2$s och %1$s')).toEqual(['%2$s']);
  });

  it('falls back to the usual spelling when the text does not contain the token', () => {
    expect(spellPlaceholders(['rails:name', 'rails-typed:n', 'printf:d', 'i18next:a', 'icu:b', 'python:c'], '')).toEqual([
      '%{name}',
      '%<n>',
      '%d',
      '{{a}}',
      '{b}',
      '%(c)'
    ]);
  });
});
