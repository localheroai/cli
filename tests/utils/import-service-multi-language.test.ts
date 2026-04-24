import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

type PushTranslationsFn = typeof import('../../src/utils/import-service.js').importService.pushTranslations;
type ImportTranslationsFn = typeof import('../../src/utils/import-service.js').importService.importTranslations;

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

interface MockCreateImportArgs {
  projectId: string;
  translations: MockTranslationPayload[];
}

describe('import-service multi_language flag threading', () => {
  let pushTranslations: PushTranslationsFn;
  let importTranslations: ImportTranslationsFn;
  let mockBulkUpdate: jest.Mock;
  let mockCreateImport: jest.Mock;
  let mockCheckStatus: jest.Mock;
  let mockGlob: jest.Mock;
  let mockReadFile: jest.Mock;
  let originalConsole: Console;

  const multiLangYaml = `en:
  greeting: Hello
sv:
  greeting: Hej
nb:
  greeting: Hei
fi:
  greeting: Moi
`;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    mockGlob = jest.fn();
    mockReadFile = jest.fn();
    mockBulkUpdate = jest.fn();
    mockCreateImport = jest.fn();
    mockCheckStatus = jest.fn();

    originalConsole = { ...console } as Console;
    global.console = {
      ...originalConsole,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    await jest.unstable_mockModule('glob', () => ({
      glob: mockGlob
    }));

    const mockStat = jest.fn().mockResolvedValue({ size: 1024 } as never);

    await jest.unstable_mockModule('fs/promises', () => ({
      readFile: mockReadFile,
      readdir: jest.fn(),
      stat: mockStat
    }));

    await jest.unstable_mockModule('fs', () => ({
      promises: {
        readFile: mockReadFile,
        readdir: jest.fn(),
        stat: mockStat
      }
    }));

    await jest.unstable_mockModule('../../src/api/imports.js', () => ({
      bulkUpdateTranslations: mockBulkUpdate,
      createImport: mockCreateImport,
      checkImportStatus: mockCheckStatus
    }));

    await jest.unstable_mockModule('../../src/utils/git-changes.js', () => ({
      filterFilesByGitChanges: jest.fn().mockReturnValue(null)
    }));

    const module_ = await import('../../src/utils/import-service.js');
    pushTranslations = module_.importService.pushTranslations.bind(module_.importService);
    importTranslations = module_.importService.importTranslations.bind(module_.importService);
  });

  afterEach(() => {
    global.console = originalConsole;
    jest.restoreAllMocks();
  });

  describe('pushTranslations', () => {
    it('sends multi_language: true on the wire for each entry of a multi-language file', async () => {
      mockGlob.mockResolvedValue(['/fake/basepath/apps/views/mailer.i18n.yml']);
      mockReadFile.mockResolvedValue(multiLangYaml);
      mockBulkUpdate.mockResolvedValue({
        import: { status: 'completed', id: 'x', poll_interval: 5 }
      });

      await pushTranslations({
        projectId: 'test',
        schemaVersion: '1.0',
        sourceLocale: 'en',
        outputLocales: ['sv', 'nb', 'fi'],
        translationFiles: {
          paths: ['apps/'],
          multiLanguageFiles: true
        },
        lastSyncedAt: null
      }, '/fake/basepath', { force: true, verbose: false });

      expect(mockBulkUpdate).toHaveBeenCalledTimes(1);
      const payload = mockBulkUpdate.mock.calls[0][0] as MockBulkUpdateArgs;
      expect(payload.translations).toHaveLength(4);
      payload.translations.forEach(t => {
        expect(t.multi_language).toBe(true);
      });
      expect(payload.translations.map(t => t.language).sort()).toEqual(['en', 'fi', 'nb', 'sv']);
    });

    it('does NOT send multi_language: true for single-language files', async () => {
      mockGlob.mockResolvedValue([
        '/fake/basepath/config/locales/en.yml',
        '/fake/basepath/config/locales/sv.yml'
      ]);
      mockReadFile.mockImplementation(async (p: unknown) => {
        const filePath = String(p);
        if (filePath.includes('en.yml')) return 'en:\n  greeting: Hello\n';
        return 'sv:\n  greeting: Hej\n';
      });
      mockBulkUpdate.mockResolvedValue({
        import: { status: 'completed', id: 'x', poll_interval: 5 }
      });

      await pushTranslations({
        projectId: 'test',
        schemaVersion: '1.0',
        sourceLocale: 'en',
        outputLocales: ['sv'],
        translationFiles: {
          paths: ['config/locales/']
        },
        lastSyncedAt: null
      }, '/fake/basepath', { force: true, verbose: false });

      const payload = mockBulkUpdate.mock.calls[0][0] as MockBulkUpdateArgs;
      expect(payload.translations.length).toBeGreaterThan(0);
      payload.translations.forEach(t => {
        expect(t.multi_language === false || t.multi_language === undefined).toBe(true);
      });
    });
  });

  describe('importTranslations', () => {
    it('sends multi_language: true on the wire for each entry of a multi-language file', async () => {
      mockGlob.mockResolvedValue(['/fake/basepath/apps/views/mailer.i18n.yml']);
      mockReadFile.mockResolvedValue(multiLangYaml);
      mockCreateImport.mockResolvedValue({
        import: { status: 'completed', id: 'x', poll_interval: 5 }
      });

      await importTranslations({
        projectId: 'test',
        schemaVersion: '1.0',
        sourceLocale: 'en',
        outputLocales: ['sv', 'nb', 'fi'],
        translationFiles: {
          paths: ['apps/'],
          multiLanguageFiles: true
        },
        lastSyncedAt: null
      }, '/fake/basepath');

      expect(mockCreateImport).toHaveBeenCalledTimes(1);
      const payload = mockCreateImport.mock.calls[0][0] as MockCreateImportArgs;
      expect(payload.translations).toHaveLength(4);
      payload.translations.forEach(t => {
        expect(t.multi_language).toBe(true);
      });
      expect(payload.translations.map(t => t.language).sort()).toEqual(['en', 'fi', 'nb', 'sv']);
    });

    it('does NOT send multi_language: true for single-language files', async () => {
      mockGlob.mockResolvedValue([
        '/fake/basepath/config/locales/en.yml',
        '/fake/basepath/config/locales/sv.yml'
      ]);
      mockReadFile.mockImplementation(async (p: unknown) => {
        const filePath = String(p);
        if (filePath.includes('en.yml')) return 'en:\n  greeting: Hello\n';
        return 'sv:\n  greeting: Hej\n';
      });
      mockCreateImport.mockResolvedValue({
        import: { status: 'completed', id: 'x', poll_interval: 5 }
      });

      await importTranslations({
        projectId: 'test',
        schemaVersion: '1.0',
        sourceLocale: 'en',
        outputLocales: ['sv'],
        translationFiles: {
          paths: ['config/locales/']
        },
        lastSyncedAt: null
      }, '/fake/basepath');

      const payload = mockCreateImport.mock.calls[0][0] as MockCreateImportArgs;
      expect(payload.translations.length).toBeGreaterThan(0);
      payload.translations.forEach(t => {
        expect(t.multi_language === false || t.multi_language === undefined).toBe(true);
      });
    });
  });
});
