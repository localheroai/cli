import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

interface MockTranslationPayload {
  language: string;
  format: string;
  filename: string;
  content: string;
  multi_language?: boolean;
}

interface MockBulkUpdateArgs {
  projectId: string;
  translations: MockTranslationPayload[];
  includePrunable?: boolean;
}

describe('pushTranslations with ignoreMatcher', () => {
  let tmp: string;
  let mockBulkUpdate: jest.Mock;
  let mockCreateImport: jest.Mock;
  let mockCheckStatus: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pushtest-'));

    mockBulkUpdate = jest.fn();
    mockCreateImport = jest.fn();
    mockCheckStatus = jest.fn();

    await jest.unstable_mockModule('../../src/api/imports.js', () => ({
      bulkUpdateTranslations: mockBulkUpdate,
      createImport: mockCreateImport,
      checkImportStatus: mockCheckStatus
    }));

    await jest.unstable_mockModule('../../src/utils/git-changes.js', () => ({
      filterFilesByGitChanges: jest.fn().mockReturnValue(null)
    }));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('filters matched keys from uploaded source content and populates ignoreSummary', async () => {
    mockBulkUpdate.mockResolvedValue({
      import: {
        status: 'completed',
        id: 'test-import',
        statistics: { created_translations: 0, updated_translations: 0 }
      }
    });

    await fs.writeFile(
      path.join(tmp, 'en.yml'),
      'en:\n  navigation:\n    home: "Home"\n  activerecord:\n    errors:\n      foo: "bar"\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(tmp, 'sv.yml'),
      'sv:\n  navigation:\n    home: "Hem"\n',
      'utf8'
    );

    const { importService, resetPoWarning } = await import('../../src/utils/import-service.js');
    const { createIgnoreMatcher } = await import('../../src/utils/ignore-keys.js');
    resetPoWarning();

    const matcher = createIgnoreMatcher(['activerecord.errors.*']);
    const result = await importService.pushTranslations(
      {
        schemaVersion: '1.0',
        projectId: 'test',
        sourceLocale: 'en',
        outputLocales: ['sv'],
        translationFiles: { paths: ['.'], ignoreKeys: ['activerecord.errors.*'] },
        lastSyncedAt: null
      },
      tmp,
      { force: true, ignoreMatcher: matcher }
    );

    expect(result.ignoreSummary).toBeDefined();
    expect(result.ignoreSummary?.totalKeysIgnored).toBe(1);

    expect(mockBulkUpdate).toHaveBeenCalledTimes(1);
    const call = mockBulkUpdate.mock.calls[0]?.[0] as MockBulkUpdateArgs;
    expect(call).toBeDefined();
    const sourceRecord = call.translations.find((t) => t.language === 'en');
    expect(sourceRecord).toBeDefined();
    const decoded = Buffer.from(sourceRecord!.content, 'base64').toString();
    expect(decoded).not.toMatch(/foo:\s*"bar"/);
    expect(decoded).toContain('navigation');
    expect(decoded).toContain('home: "Home"');
  });
});
