import { describe, it, expect } from '@jest/globals';
import { summarizeImport } from '../../src/utils/import-summary.js';
import type { TargetChangeFile } from '../../src/utils/target-changes.js';

const sourceFile = (changes: string[], path = 'config/locales/en.yml'): TargetChangeFile => ({
  path,
  source_path: path,
  locale: 'en',
  format: 'yaml',
  changes: changes.map((key) => ({ key, status: 'updated' as const, value: 'new', old_value: 'old' }))
});

const targetFile = (changes: string[], path = 'config/locales/fr.yml'): TargetChangeFile => ({
  path,
  source_path: 'config/locales/en.yml',
  locale: 'fr',
  format: 'yaml',
  changes: changes.map((key) => ({ key, status: 'added' as const, value: 'valeur' }))
});

describe('summarizeImport', () => {
  it('counts a reworded source text as imported when the backend accepted it', () => {
    const summary = summarizeImport([sourceFile(['checkout.place_order'])], 'en', {
      imported_count: 1,
      skipped: [],
      unchanged: []
    });

    expect(summary).toEqual({ importedCount: 1, unchangedCount: 0, sourceTextsImported: 1 });
  });

  it('does not count target edits as source texts', () => {
    const summary = summarizeImport([targetFile(['greeting', 'farewell'])], 'en', {
      imported_count: 2,
      skipped: [],
      unchanged: []
    });

    expect(summary.sourceTextsImported).toBe(0);
    expect(summary.importedCount).toBe(2);
  });

  it('separates source texts from target edits in a mixed import', () => {
    const summary = summarizeImport([sourceFile(['a', 'b']), targetFile(['c'])], 'en', {
      imported_count: 3,
      skipped: [],
      unchanged: []
    });

    expect(summary.sourceTextsImported).toBe(2);
  });

  it('drops source texts the backend skipped or found unchanged', () => {
    const summary = summarizeImport([sourceFile(['a', 'b', 'c'])], 'en', {
      imported_count: 1,
      skipped: [{ path: 'config/locales/en.yml', key: 'a', reason: 'key_not_found' }],
      unchanged: [{ path: 'config/locales/en.yml', key: 'b' }]
    });

    expect(summary).toEqual({ importedCount: 1, unchangedCount: 1, sourceTextsImported: 1 });
  });

  it('keeps source and target apart when they share a multi-language file', () => {
    const shared = 'config/locales/app.yml';
    const summary = summarizeImport([sourceFile(['title'], shared), targetFile(['subtitle'], shared)], 'en', {
      imported_count: 1,
      skipped: [],
      unchanged: [{ path: shared, key: 'subtitle', locale: 'fr' }]
    });

    expect(summary).toEqual({ importedCount: 1, unchangedCount: 1, sourceTextsImported: 1 });
  });

  it('uses the locale to tell a source text from a target edit of the same key in one file', () => {
    const shared = 'config/locales/app.yml';
    const summary = summarizeImport([sourceFile(['title'], shared), targetFile(['title'], shared)], 'en', {
      imported_count: 1,
      skipped: [],
      unchanged: [{ path: shared, key: 'title', locale: 'fr' }]
    });

    expect(summary.sourceTextsImported).toBe(1);
  });

  it('falls back to path and key when the backend omits the locale', () => {
    const summary = summarizeImport([sourceFile(['a', 'b'])], 'en', {
      imported_count: 1,
      skipped: [{ path: 'config/locales/en.yml', key: 'a', reason: 'key_not_found' }]
    });

    expect(summary.sourceTextsImported).toBe(1);
  });

  it('tolerates a backend that does not report unchanged values', () => {
    const summary = summarizeImport([sourceFile(['a'])], 'en', {
      imported_count: 1,
      skipped: []
    });

    expect(summary).toEqual({ importedCount: 1, unchangedCount: 0, sourceTextsImported: 1 });
  });
});
