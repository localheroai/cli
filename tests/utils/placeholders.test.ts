import { describe, it, expect } from '@jest/globals';
import { extractPlaceholders, placeholderMultiset } from '../../src/utils/placeholders.js';

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
    expect(extractPlaceholders('%1$s of %2$s')).toEqual([
      { kind: 'positional', name: '1' },
      { kind: 'positional', name: '2' }
    ]);
  });

  it('extracts Python %(name)s', () => {
    expect(extractPlaceholders('%(name)s')).toEqual([{ kind: 'python', name: 'name' }]);
  });

  it('does not treat a literal percent sign followed by a space as a directive', () => {
    expect(extractPlaceholders('Save 10% off')).toEqual([]);
    expect(extractPlaceholders('100%')).toEqual([]);
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
