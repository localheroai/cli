import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import type { ProjectConfig, TranslationFile } from '../../src/types/index.js';

const mockFlatValuesAt = jest.fn<any>();
let collectDocumentAlignmentCandidates: any;

beforeAll(async () => {
  const actual: any = await import('../../src/utils/git-changes.js');
  await jest.unstable_mockModule('../../src/utils/git-changes.js', () => ({
    ...actual,
    resolveCompareRef: () => 'merge-base',
    flatValuesAt: mockFlatValuesAt
  }));
  ({ collectDocumentAlignmentCandidates } = await import('../../src/utils/document-alignment.js'));
});

const config = { sourceLocale: 'en', outputLocales: ['sv', 'de'], translationFiles: { paths: ['articles/'] } } as ProjectConfig;

function target(locale: string, text: string): TranslationFile {
  return {
    path: `articles/${locale}/export-reports.md`,
    format: 'md',
    locale,
    documentFormat: 'markdown',
    content: Buffer.from(text).toString('base64')
  };
}

const edited = [{
  path: 'articles/en/export-reports.md',
  source_path: 'articles/en/export-reports.md',
  locale: 'en',
  format: 'markdown',
  changes: [{ key: 'export-reports.md', status: 'updated' as const, value: '# Export, reworded\n', old_value: '# Export\n' }]
}];

describe('collectDocumentAlignmentCandidates when git cannot read the base', () => {
  it('sends nothing for that translation, says why, and still asks for the others', () => {
    mockFlatValuesAt.mockImplementation((file: TranslationFile) => {
      if (file.locale === 'sv') throw new Error('fatal: bad object merge-base');
      return { 'export-reports.md': '# Bericht\n' };
    });
    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });

    const candidates = collectDocumentAlignmentCandidates(
      edited,
      { sv: [target('sv', '# Rapport\n')], de: [target('de', '# Bericht\n')] },
      config,
      false
    );
    log.mockRestore();

    expect(candidates.map((candidate: any) => candidate.locale)).toEqual(['de']);
    expect(candidates[0].target_base).toBe('# Bericht\n');
    expect(lines.join('\n')).toContain(
      'sv: export-reports.md not updated: git could not read its translation on the base branch (fatal: bad object merge-base)'
    );
  });
});
