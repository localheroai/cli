import { describe, it, expect } from '@jest/globals';
import { buildStepSummary, type ProblemCounts } from '../../src/utils/check-summary.js';

const NONE: ProblemCounts = { missing: 0, placeholders: 0, plurals: 0, structure: 0, conflicts: 0, orphans: 0 };

describe('buildStepSummary', () => {
  it("lists the change's problems per locale and counts the existing ones", () => {
    const markdown = buildStepSummary({
      changes: { base: 'main (abc1234)' },
      problems: [
        { locale: 'sv', file: 'config/locales/sv.yml', message: 'Missing translation for "new" (locale sv)' },
        { locale: 'de', file: 'config/locales/de.yml', message: 'Missing translation for "new" (locale de)' }
      ],
      counts: [
        { locale: 'sv', counts: { ...NONE, missing: 3, orphans: 1 } },
        { locale: 'de', counts: NONE }
      ],
      missingTranslations: true
    });

    expect(markdown).toContain('Compared with `main (abc1234)`: 2 new problems.');
    expect(markdown).toContain('#### sv\n\n- Missing translation for "new" (locale sv) in `config/locales/sv.yml`');
    expect(markdown).toContain('#### de\n\n- Missing translation for "new" (locale de)');
    expect(markdown).toContain('### Existing problems');
    expect(markdown).toContain('| sv | 3 | 0 | 0 | 0 | 0 | 1 |');
    expect(markdown).not.toContain('| de |');
    expect(markdown).toContain('Localhero.ai can fill missing translations automatically: https://localhero.ai\n');
  });

  it('says when the change adds no problems and leaves out the Localhero.ai line without missing translations', () => {
    const markdown = buildStepSummary({ changes: { base: 'main' }, problems: [], counts: [], missingTranslations: false });

    expect(markdown).toContain('No new problems.');
    expect(markdown).not.toContain('Existing problems');
    expect(markdown).not.toContain('localhero.ai');
  });

  it('explains a failed comparison and counts every problem instead', () => {
    const markdown = buildStepSummary({
      changes: { error: 'the base commit abc1234 is not in this checkout' },
      problems: [],
      counts: [{ locale: 'sv', counts: { ...NONE, missing: 2 } }],
      missingTranslations: true
    });

    expect(markdown).toContain('Could not compare with the base branch: the base commit abc1234 is not in this checkout.');
    expect(markdown).toContain('fetch-depth: 0');
    expect(markdown).toContain('### Problems found');
    expect(markdown).toContain('| sv | 2 | 0 | 0 | 0 | 0 | 0 |');
  });

  it('lists every problem of a full check', () => {
    const markdown = buildStepSummary({
      changes: null,
      problems: [{ locale: 'sv', file: 'sv.yml', message: 'Missing translation for "a" (locale sv)' }],
      counts: [],
      missingTranslations: true
    });

    expect(markdown).toContain('1 problem found.');
    expect(markdown).toContain('- Missing translation for "a" (locale sv) in `sv.yml`');
  });

  it('caps the list', () => {
    const problems = Array.from({ length: 60 }, (_, i) => ({ locale: 'sv', file: 'sv.yml', message: `Problem ${i}` }));

    const markdown = buildStepSummary({ changes: null, problems, counts: [], missingTranslations: false });

    expect(markdown.match(/^- Problem/gm)).toHaveLength(50);
    expect(markdown).toContain('10 more not shown');
  });

  it('escapes markdown in messages', () => {
    const markdown = buildStepSummary({
      changes: null,
      problems: [{ locale: 'sv', file: 'sv.yml', message: 'Missing translation for "<b>*x*</b>" (locale sv)' }],
      counts: [],
      missingTranslations: false
    });

    expect(markdown).toContain('"\\<b\\>\\*x\\*\\</b\\>"');
  });
});
