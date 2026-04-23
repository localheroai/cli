import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

type FindTranslationFilesFn = typeof import('../../src/utils/files.js').findTranslationFiles;

describe('findTranslationFiles multi-language file fan-out', () => {
  let findTranslationFiles: FindTranslationFilesFn;
  let mockGlob: jest.Mock;
  let mockReadFile: jest.Mock;
  let originalConsole: Console;

  beforeEach(async () => {
    jest.resetModules();

    mockGlob = jest.fn();
    mockReadFile = jest.fn();

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

    await jest.unstable_mockModule('fs/promises', () => ({
      readFile: mockReadFile,
      readdir: jest.fn(),
      stat: jest.fn()
    }));

    const filesModule = await import('../../src/utils/files.js');
    findTranslationFiles = filesModule.findTranslationFiles;
  });

  afterEach(() => {
    global.console = originalConsole;
  });

  const multiLangYaml = `en:
  greeting: Hello
  nested:
    world: World
sv:
  greeting: Hej
  nested:
    world: Världen
nb:
  greeting: Hei
  nested:
    world: Verden
fi:
  greeting: Moi
  nested:
    world: Maailma
`;

  it('fans out a multi-language YAML file into one entry per top-level locale when multiLanguageFiles is true', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(multiLangYaml);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    expect(Array.isArray(result)).toBe(true);
    const files = result as Array<{
      path: string;
      locale: string;
      format: string;
      multiLanguage?: boolean;
      hasLanguageWrapper?: boolean;
      translations?: Record<string, unknown>;
      keys?: Record<string, unknown>;
    }>;

    expect(files).toHaveLength(4);

    const locales = files.map(f => f.locale).sort();
    expect(locales).toEqual(['en', 'fi', 'nb', 'sv']);

    files.forEach(file => {
      expect(file.path).toBe('config/locales/invitation.i18n.yml');
      expect(file.format).toBe('yml');
      expect(file.multiLanguage).toBe(true);
      expect(file.hasLanguageWrapper).toBe(true);
    });

    const enEntry = files.find(f => f.locale === 'en')!;
    expect(enEntry.translations).toEqual({
      greeting: 'Hello',
      nested: { world: 'World' }
    });
    expect(enEntry.keys).toEqual({
      greeting: 'Hello',
      'nested.world': 'World'
    });

    const svEntry = files.find(f => f.locale === 'sv')!;
    expect(svEntry.translations).toEqual({
      greeting: 'Hej',
      nested: { world: 'Världen' }
    });
    expect(svEntry.keys).toEqual({
      greeting: 'Hej',
      'nested.world': 'Världen'
    });
  });

  it('includes multi-language fan-out entries in sourceFiles when locale matches and returnFullResult is true', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(multiLangYaml);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    }, {
      returnFullResult: true
    });

    expect('allFiles' in result).toBe(true);
    const fullResult = result as { allFiles: unknown[]; sourceFiles: unknown[]; targetFilesByLocale: Record<string, unknown[]> };

    expect(fullResult.allFiles).toHaveLength(4);
    expect(fullResult.sourceFiles).toHaveLength(1);
    expect((fullResult.sourceFiles[0] as { locale: string }).locale).toBe('en');
    expect(fullResult.targetFilesByLocale.sv).toHaveLength(1);
    expect(fullResult.targetFilesByLocale.nb).toHaveLength(1);
    expect(fullResult.targetFilesByLocale.fi).toHaveLength(1);
  });

  it('does not fan out when multiLanguageFiles flag is absent — byte-identical to today', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(multiLangYaml);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/']
      }
    });

    const files = result as Array<{ path: string; locale: string }>;
    expect(files).toHaveLength(0);
    expect((global.console.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('Could not extract locale from path'),
      expect.any(String)
    );
  });

  it('does not fan out when multiLanguageFiles is false — byte-identical to today', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(multiLangYaml);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: false
      }
    });

    const files = result as Array<{ path: string; locale: string }>;
    expect(files).toHaveLength(0);
  });

  it('falls through to single-lang handling when top-level keys include a non-locale', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.yml']);
    mockReadFile.mockResolvedValue(`en:
  greeting: Hello
users:
  name: Name
`);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string; hasLanguageWrapper?: boolean; multiLanguage?: boolean; translations?: Record<string, unknown> }>;
    expect(files).toHaveLength(1);
    expect(files[0].locale).toBe('en');
    expect(files[0].multiLanguage).toBeUndefined();
    expect(files[0].hasLanguageWrapper).toBe(true);
    expect(files[0].translations).toEqual({ greeting: 'Hello' });
  });

  it('falls through to single-lang wrapper handling when only one top-level locale key is present', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.yml']);
    mockReadFile.mockResolvedValue(`en:
  greeting: Hello
`);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string; hasLanguageWrapper?: boolean; multiLanguage?: boolean }>;
    expect(files).toHaveLength(1);
    expect(files[0].locale).toBe('en');
    expect(files[0].hasLanguageWrapper).toBe(true);
    expect(files[0].multiLanguage).toBeUndefined();
  });

  it('falls through when top-level keys have mismatched case (case-sensitive rejection)', async () => {
    mockGlob.mockResolvedValue(['config/locales/en.yml']);
    mockReadFile.mockResolvedValue(`EN:
  greeting: Hello
SV:
  greeting: Hej
`);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string; multiLanguage?: boolean }>;
    expect(files).toHaveLength(1);
    expect(files[0].locale).toBe('en');
    expect(files[0].multiLanguage).toBeUndefined();
  });

  it('preserves case-sensitive regional locales like pt-BR verbatim in the emitted locale', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(`en:
  greeting: Hello
pt-BR:
  greeting: Olá
`);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['pt-BR'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string; multiLanguage?: boolean }>;
    expect(files).toHaveLength(2);
    const ptBrEntry = files.find(f => f.locale === 'pt-BR');
    expect(ptBrEntry).toBeDefined();
    expect(ptBrEntry!.multiLanguage).toBe(true);
  });

  it('propagates parse errors via the outer try/catch so they surface as warnings — no silent fallback', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue('en:\n  greeting: "unterminated');

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string }>;
    expect(files).toHaveLength(0);
    expect((global.console.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse')
    );
  });

  it('handles multi-language JSON files as well', async () => {
    mockGlob.mockResolvedValue(['config/locales/messages.i18n.json']);
    mockReadFile.mockResolvedValue(JSON.stringify({
      en: { greeting: 'Hello' },
      sv: { greeting: 'Hej' }
    }));

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    });

    const files = result as Array<{ path: string; locale: string; format: string; multiLanguage?: boolean; translations?: Record<string, unknown> }>;
    expect(files).toHaveLength(2);
    files.forEach(file => {
      expect(file.format).toBe('json');
      expect(file.multiLanguage).toBe(true);
    });
    expect(files.find(f => f.locale === 'en')!.translations).toEqual({ greeting: 'Hello' });
    expect(files.find(f => f.locale === 'sv')!.translations).toEqual({ greeting: 'Hej' });
  });

  it('emits content in base64 on each fan-out entry when includeContent is true', async () => {
    const rawContent = multiLangYaml;
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(rawContent);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    }, {
      includeContent: true
    });

    const files = result as Array<{ content?: string }>;
    const expectedBase64 = Buffer.from(rawContent).toString('base64');
    files.forEach(file => {
      expect(file.content).toBe(expectedBase64);
    });
  });

  it('skips keys extraction when extractKeys is false', async () => {
    mockGlob.mockResolvedValue(['config/locales/invitation.i18n.yml']);
    mockReadFile.mockResolvedValue(multiLangYaml);

    const result = await findTranslationFiles({
      sourceLocale: 'en',
      outputLocales: ['sv', 'nb', 'fi'],
      translationFiles: {
        paths: ['config/locales/'],
        multiLanguageFiles: true
      }
    }, {
      extractKeys: false
    });

    const files = result as Array<{ locale: string; translations?: unknown; keys?: unknown; multiLanguage?: boolean }>;
    expect(files).toHaveLength(4);
    files.forEach(file => {
      expect(file.multiLanguage).toBe(true);
      expect(file.translations).toBeUndefined();
      expect(file.keys).toBeUndefined();
    });
  });
});
