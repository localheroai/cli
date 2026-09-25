import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { runCheck, check, CheckOptions } from '../../src/commands/check.js';
import type { TranslationConfig, TranslationFile } from '../../src/types/index.js';
import type { ProjectDetectionResult } from '../../src/utils/project-detection.js';
import { fakeGit, type FakeGit } from '../helpers/fake-git.js';

function yamlFile(locale: string, body: string, dir = 'config/locales'): TranslationFile {
  return {
    path: `${dir}/${locale}.yml`,
    format: 'yml',
    locale,
    content: Buffer.from(`${locale}:\n${body}`).toString('base64')
  };
}

function poFile(locale: string, body: string, filePath = `locale/${locale}.po`): TranslationFile {
  const header = `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: ${locale}\\n"\n\n`;
  return {
    path: filePath,
    format: 'po',
    locale,
    content: Buffer.from(header + body).toString('base64')
  };
}

describe('check command', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock };
  let config: TranslationConfig;
  let files: TranslationFile[];
  let parseFailures: { path: string; error: string }[];
  let noConfig: boolean;
  let rawContents: Record<string, string>;
  let projectType: ProjectDetectionResult;
  let env: Record<string, string>;
  let git: FakeGit;
  let appendFile: jest.Mock;

  beforeEach(() => {
    mockConsole = { log: jest.fn(), error: jest.fn() };
    config = {
      projectId: 'test',
      sourceLocale: 'en',
      outputLocales: ['sv'],
      translationFiles: { paths: ['config/locales/'] }
    } as TranslationConfig;
    files = [];
    parseFailures = [];
    noConfig = false;
    rawContents = {};
    projectType = { type: 'rails', defaults: { translationPath: 'config/locales/', filePattern: '**/*.{yml,yaml}' } };
    env = {};
    git = fakeGit({ isRepo: false });
    appendFile = jest.fn();
    process.exitCode = undefined;
  });

  function deps() {
    return {
      console: mockConsole,
      configUtils: { getProjectConfig: jest.fn(async () => (noConfig ? null : config)) },
      fileUtils: {
        findTranslationFiles: jest.fn(async (_: TranslationConfig, options: { sourceLocale: string; targetLocales: string[] }) => ({
          allFiles: files,
          sourceFiles: files.filter((f) => f.locale === options.sourceLocale),
          targetFilesByLocale: Object.fromEntries(
            options.targetLocales.map((l) => [l, files.filter((f) => f.locale === l)])
          ),
          parseFailures
        }))
      },
      projectDetection: { detectProjectType: jest.fn(async () => projectType) },
      fsUtils: {
        listFiles: jest.fn(async () => files.map((f) => f.path)),
        readFile: jest.fn(async (filePath: string) => {
          const file = files.find((f) => f.path === filePath);
          return rawContents[filePath] ?? Buffer.from(file?.content ?? '', 'base64').toString('utf8');
        })
      },
      env,
      git,
      appendFile
    };
  }

  function run(options: CheckOptions = {}) {
    return runCheck(options, deps() as never);
  }

  function printed(): string {
    return mockConsole.log.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('exits 1 on a missing key and 0 when complete', async () => {
    files = [yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  a: "A-sv"\n')];
    expect((await run()).exitCode).toBe(1);

    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];
    expect((await run()).exitCode).toBe(0);
  });

  it('does not report keys matched by ignoreKeys', async () => {
    config.translationFiles.ignoreKeys = ['internal.*'];
    files = [
      yamlFile('en', '  internal:\n    debug: "Debug"\n    note: "Hi %{name}"\n  a: "A"\n'),
      yamlFile('sv', '  internal:\n    note: "Hej"\n    stale: "x"\n  a: "A-sv"\n')
    ];

    const { exitCode, reports } = await run({ failOn: 'any' });

    expect(exitCode).toBe(0);
    expect(reports[0].missing).toEqual([]);
    expect(reports[0].placeholderMismatches).toEqual([]);
    expect(reports[0].orphans).toEqual([]);
  });

  it('reports an empty target value once, as empty rather than also missing', async () => {
    files = [yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  a: ""\n')];

    const { reports } = await run();

    expect(reports[0].empty.map((f) => f.key)).toEqual(['a']);
    expect(reports[0].missing.map((f) => f.key)).toEqual(['b']);
  });

  it('rejects an unknown --fail-on value', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];

    const { exitCode } = await run({ failOn: 'typo' as never });

    expect(exitCode).toBe(1);
    expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('--fail-on'));
  });

  it('rejects an unknown --format value', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];

    const { exitCode } = await run({ format: 'gitlab' as never });

    expect(exitCode).toBe(1);
    expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('--format'));
  });

  it('prints only the error when the check cannot run', async () => {
    await check({ failOn: 'typo' as never }, deps() as never);

    expect(mockConsole.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports a string that became a map once, as a structure mismatch', async () => {
    files = [
      yamlFile('en', '  example: "{ \\"a\\": 1 }"\n'),
      yamlFile('sv', '  example:\n    a: 1\n')
    ];

    const { reports } = await run();

    expect(reports[0].structureMismatches).toEqual([
      { key: 'example', sourceShape: 'string', targetShape: 'map', path: 'config/locales/sv.yml' }
    ]);
    expect(reports[0].missing).toEqual([]);
    expect(reports[0].orphans).toEqual([]);
  });

  it('reports a plural group collapsed to a flat string once, as a plural-shape mismatch', async () => {
    files = [
      yamlFile('en', '  items:\n    one: "1 item"\n    other: "%{count} items"\n'),
      yamlFile('sv', '  items: "objekt"\n')
    ];

    const { reports } = await run();

    expect(reports[0].pluralShapeMismatches.map((f) => f.key)).toEqual(['items']);
    expect(reports[0].missing).toEqual([]);
    expect(reports[0].orphans).toEqual([]);
  });

  it('accepts a target that pluralizes a flat source string', async () => {
    config.outputLocales = ['pl'];
    files = [
      yamlFile('en', '  items: "%{count} items"\n'),
      yamlFile('pl', '  items:\n    one: "1 rzecz"\n    few: "%{count} rzeczy"\n    many: "%{count} rzeczy"\n    other: "%{count} rzeczy"\n')
    ];

    const { exitCode, reports } = await run();

    expect(exitCode).toBe(0);
    expect(reports[0].missing).toEqual([]);
    expect(reports[0].orphans).toEqual([]);
  });

  it('counts array values as source keys', async () => {
    files = [yamlFile('en', '  benefits: ["Fast", "Reliable"]\n'), yamlFile('sv', '  other_key: "x"\n')];

    const { keyCount, reports } = await run();

    expect(keyCount).toBe(1);
    expect(reports[0].missing.map((f) => f.key)).toEqual(['benefits']);
  });

  it('does not require plural categories the target language never uses', async () => {
    config.outputLocales = ['sv', 'pl'];
    files = [
      yamlFile('en', '  items:\n    one: "1 item"\n    few: "%{count} items"\n    many: "%{count} items"\n    other: "%{count} items"\n'),
      yamlFile('sv', '  items:\n    one: "1 sak"\n    other: "%{count} saker"\n'),
      yamlFile('pl', '  items:\n    one: "1 rzecz"\n    other: "%{count} rzeczy"\n')
    ];

    const { reports } = await run();

    expect(reports[0].missing).toEqual([]);
    expect(reports[1].missing.map((f) => f.key).sort()).toEqual(['items.few', 'items.many']);
  });

  it('fails the run when a translation file could not be parsed', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];
    parseFailures = [{ path: 'config/locales/de.yml', error: 'bad indentation' }];

    expect((await run()).exitCode).toBe(1);
    expect((await run({ failOn: 'none' })).exitCode).toBe(0);
  });

  it('does not report PO keys matched by ignoreKeys as missing', async () => {
    config.translationFiles = { paths: ['locale/'], ignoreKeys: ['Ignore me'] };
    files = [poFile('en', 'msgid "Ignore me"\nmsgstr ""\n'), poFile('sv', '')];

    const { reports } = await run();

    expect(reports[0].missing).toEqual([]);
  });

  it('compares PO targets against a source whose msgstr is left blank', async () => {
    config.translationFiles = { paths: ['locale/'] };
    files = [
      poFile('en', 'msgid "Hello %(name)s"\nmsgstr ""\n'),
      poFile('sv', 'msgid "Hello %(name)s"\nmsgstr "Hej"\n')
    ];

    const { reports } = await run();

    expect(reports[0].placeholderMismatches.map((f) => f.key)).toEqual(['Hello %(name)s']);
  });

  it('reports duplicate keys in a YAML file instead of failing to parse it', async () => {
    files = [yamlFile('en', '  a: "A"\n  b: "B"\n')];
    rawContents['config/locales/sv.yml'] = 'sv:\n  a: "A-sv"\n  b: "Gammal"\n  b: "Ny"\n';
    parseFailures = [{ path: 'config/locales/sv.yml', error: 'Map keys must be unique at line 4, column 3' }];

    const { exitCode, reports, parseFailures: remaining } = await run();

    expect(remaining).toEqual([]);
    expect(reports[0].missing).toEqual([]);
    expect(reports[0].duplicateKeys).toEqual([{ key: 'b', path: 'config/locales/sv.yml', values: ['Gammal', 'Ny'] }]);
    expect(exitCode).toBe(0);
  });

  it('caps GitHub annotations and says how many were left out', async () => {
    const keys = Array.from({ length: 60 }, (_, i) => `  k${i}: "K${i}"\n`).join('');
    files = [yamlFile('en', keys), yamlFile('sv', '  k0: "K0-sv"\n')];

    await check({ format: 'github' }, deps() as never);

    const lines = printed().split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[50]).toMatch(/^::warning::.*9 more findings.*--json/);
  });

  it('escapes GitHub annotation messages and properties', async () => {
    config.translationFiles = { paths: ['locale/'] };
    files = [
      poFile('en', 'msgid "Line one\\nLine two: 100%"\nmsgstr "Line one\\nLine two: 100%"\n'),
      poFile('sv', '')
    ];

    await check({ format: 'github' }, deps() as never);

    const lines = printed().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '::error file=locale/en.po,line=6::Missing translation for "Line one%0ALine two: 100%25" (locale sv)'
    );
  });

  it('includes loaded files and parse failures in the JSON report', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];

    await check({ json: true }, deps() as never);

    const report = JSON.parse(printed());
    expect(report.parseFailures).toEqual([]);
    expect(report.locales[0].files).toEqual(['config/locales/sv.yml']);
  });

  it('does not report a target key as an orphan when another source file defines it', async () => {
    files = [
      yamlFile('en', '  shared: "Shared"\n'),
      yamlFile('en', '  a: "A"\n', 'config/locales/app'),
      yamlFile('sv', '  shared: "Delad"\n'),
      yamlFile('sv', '  a: "A-sv"\n  shared: "Delad"\n  stale: "Gammal"\n', 'config/locales/app')
    ];

    const { reports } = await run();

    expect(reports[0].orphans).toEqual([{ key: 'stale', target: 'Gammal', path: 'config/locales/app/sv.yml' }]);
  });

  it('does not report plural forms for a flat source string in another file as orphans', async () => {
    config.outputLocales = ['pl'];
    files = [
      yamlFile('en', '  items: "%{count} items"\n'),
      yamlFile('en', '  a: "A"\n', 'config/locales/app'),
      yamlFile('pl', '  a: "A-pl"\n  items:\n    one: "1 rzecz"\n    few: "%{count} rzeczy"\n    many: "%{count} rzeczy"\n    other: "%{count} rzeczy"\n', 'config/locales/app')
    ];

    const { reports } = await run();

    expect(reports[0].orphans).toEqual([]);
  });

  it('reports a key two YAML files of a target locale define with different values', async () => {
    files = [
      yamlFile('en', '  app:\n    title: "Title"\n    ok: "OK"\n', 'config/locales/app'),
      yamlFile('sv', '  app:\n    title: "Ny titel"\n    ok: "OK"\n', 'config/locales/app'),
      yamlFile('sv', '  app:\n    title: "Gammal titel"\n    ok: "OK"\n', 'config/locales/pages')
    ];

    const { exitCode, reports } = await run();

    expect(exitCode).toBe(0);
    expect(reports[0].conflictingKeys).toEqual([
      {
        key: 'app.title',
        files: ['config/locales/app/sv.yml', 'config/locales/pages/sv.yml'],
        values: ['Ny titel', 'Gammal titel']
      }
    ]);
    expect((await run({ failOn: 'any' })).exitCode).toBe(1);
  });

  it('does not compare multi-language files, which are often scoped to one view', async () => {
    const multiFile = (path: string, sv: string): TranslationFile => ({
      path,
      format: 'yml',
      locale: 'sv',
      content: Buffer.from(`en:\n  subject: "Subject"\nsv:\n  subject: "${sv}"\n`).toString('base64'),
      multiLanguage: true
    });
    files = [
      yamlFile('en', '  subject: "Subject"\n'),
      yamlFile('sv', '  subject: "Ämne"\n'),
      multiFile('views/welcome.i18n.yml', 'Välkommen'),
      multiFile('views/reminder.i18n.yml', 'Påminnelse')
    ];

    const { reports } = await run();

    expect(reports[0].conflictingKeys).toEqual([]);
  });

  it('does not report duplicate keys across gettext domains', async () => {
    config.translationFiles = { paths: ['locale/'] };
    const djangojs = poFile('sv', 'msgid "Save"\nmsgstr "Spara ändringar"\n');
    files = [
      poFile('en', 'msgid "Save"\nmsgstr ""\n'),
      poFile('sv', 'msgid "Save"\nmsgstr "Spara"\n'),
      { ...djangojs, path: 'locale/sv/djangojs.po' }
    ];

    const { reports } = await run();

    expect(reports[0].conflictingKeys).toEqual([]);
  });

  it('prints conflicting keys in the human, GitHub and JSON reports', async () => {
    files = [
      yamlFile('en', '  title: "Title"\n'),
      yamlFile('sv', '  title: "Ny titel"\n'),
      yamlFile('sv', '  title: "Gammal titel"\n', 'config/locales/pages')
    ];

    await check({}, deps() as never);
    expect(printed()).toContain('title: config/locales/sv.yml, config/locales/pages/sv.yml');

    mockConsole.log.mockClear();
    await check({ format: 'github' }, deps() as never);
    expect(printed()).toBe(
      '::error file=config/locales/sv.yml,line=2::"title" has different values in config/locales/sv.yml, config/locales/pages/sv.yml (locale sv)'
    );

    mockConsole.log.mockClear();
    await check({ json: true }, deps() as never);
    expect(JSON.parse(printed()).locales[0].conflictingKeys).toHaveLength(1);
  });

  it('keeps file discovery notices off stdout in --json mode', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];
    const checkDeps = deps();
    checkDeps.fileUtils.findTranslationFiles.mockImplementation(async (_config, options) => {
      (options?.logger ?? console).log('ℹ Multi-language files: beta feature');
      return { allFiles: files, sourceFiles: [files[0]], targetFilesByLocale: { sv: [files[1]] }, parseFailures };
    });

    await check({ json: true }, checkDeps as never);

    expect(() => JSON.parse(printed())).not.toThrow();
    expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('beta feature'));
  });

  it('lists the files loaded for each target locale', async () => {
    files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];

    await check({}, deps() as never);

    expect(printed()).toContain('sv: config/locales/sv.yml');
  });

  describe('without localhero.json', () => {
    beforeEach(() => {
      noConfig = true;
    });

    it('detects the locale folder and languages, with en as the source', async () => {
      files = [
        yamlFile('en', '  a: "A"\n  b: "B"\n'),
        yamlFile('sv', '  a: "A-sv"\n'),
        yamlFile('de', '  a: "A-de"\n  b: "B-de"\n')
      ];

      const { exitCode, sourceLocale, reports } = await run();

      expect(sourceLocale).toBe('en');
      expect(reports.map((r) => r.locale).sort()).toEqual(['de', 'sv']);
      expect(reports.find((r) => r.locale === 'sv')!.missing.map((m) => m.key)).toEqual(['b']);
      expect(exitCode).toBe(1);
      expect(printed()).toContain('No localhero.json');
    });

    it('leaves files without a locale out of the scan instead of warning about each', async () => {
      files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];
      const checkDeps = deps();
      checkDeps.fsUtils.listFiles.mockResolvedValue([...files.map((f) => f.path), 'config/locales/shared_glossary.yml']);

      await runCheck({}, checkDeps as never);

      const [scannedConfig] = checkDeps.fileUtils.findTranslationFiles.mock.calls[0] as [TranslationConfig];
      expect(scannedConfig.translationFiles.ignore).toEqual(['config/locales/shared_glossary.yml']);
    });

    it('scans --path with --pattern instead of detecting', async () => {
      files = [yamlFile('en', '  a: "A"\n', 'i18n'), yamlFile('sv', '  a: "A-sv"\n', 'i18n')];
      const checkDeps = deps();

      const { exitCode } = await runCheck({ path: 'i18n', pattern: '**/*.yml' }, checkDeps as never);

      expect(exitCode).toBe(0);
      expect(checkDeps.projectDetection.detectProjectType).not.toHaveBeenCalled();
      expect(checkDeps.fsUtils.listFiles).toHaveBeenCalledWith(['i18n/'], '**/*.yml', []);
    });

    it('says when the source language is a guess', async () => {
      files = [yamlFile('sv', '  a: "A"\n  b: "B"\n'), yamlFile('de', '  a: "A-de"\n')];

      const { sourceLocale } = await run();

      expect(sourceLocale).toBe('sv');
      expect(printed()).toMatch(/guess/i);
      expect(printed()).toContain('--source');
    });

    it('uses the gettext catalog that looks like a source', async () => {
      projectType = { type: 'django', defaults: { translationPath: 'locale/', filePattern: '**/*.{po,pot}' } };
      files = [
        poFile('sv', 'msgid "Hej"\nmsgstr ""\n', 'locale/sv/LC_MESSAGES/django.po'),
        poFile('en', 'msgid "Hej"\nmsgstr "Hello"\n', 'locale/en/LC_MESSAGES/django.po')
      ];

      const { sourceLocale, reports } = await run();

      expect(sourceLocale).toBe('sv');
      expect(reports.map((r) => r.locale)).toEqual(['en']);
    });

    it('does not treat locales without a counterpart of a source file as targets', async () => {
      files = [
        yamlFile('en', '  a: "A"\n'),
        yamlFile('sv', '  a: "A-sv"\n'),
        yamlFile('fr', '  date:\n    today: "Aujourd\'hui"\n', 'config/locales/rails-i18n')
      ];

      const { reports } = await run();

      expect(reports.map((r) => r.locale)).toEqual(['sv']);
      expect(printed()).toContain('fr');
      expect(printed()).toContain('--locales');
    });

    it('includes .pot templates when detection picked a gettext pattern', async () => {
      projectType = { type: 'detected', defaults: { translationPath: 'translations/', filePattern: '**/*.po' } };
      files = [poFile('sv', 'msgid "Hello"\nmsgstr "Hej"\n', 'translations/sv.po')];
      const checkDeps = deps();
      checkDeps.fsUtils.listFiles.mockResolvedValue(['translations/messages.pot', 'translations/sv.po']);

      const { sourceLocale } = await runCheck({}, checkDeps as never);

      expect(checkDeps.fsUtils.listFiles).toHaveBeenCalledWith(['translations/'], '**/*.{po,pot}', []);
      expect(sourceLocale).toBe('en');
    });

    it('counts gettext plural entries as keys, not their metadata, when guessing the source', async () => {
      projectType = { type: 'django', defaults: { translationPath: 'locale/', filePattern: '**/*.po' } };
      const plain = ['A', 'B', 'C', 'D'].map((id) => `msgid "${id}"\nmsgstr "${id}-sv"\n`).join('\n');
      const plural = 'msgid "1 file"\nmsgid_plural "%d files"\nmsgstr[0] "1 Datei"\nmsgstr[1] "%d Dateien"\n';
      files = [
        poFile('sv', plain, 'locale/sv/LC_MESSAGES/django.po'),
        poFile('de', plural, 'locale/de/LC_MESSAGES/django.po')
      ];

      const { sourceLocale } = await run();

      expect(sourceLocale).toBe('sv');
    });

    it('scans an absolute --path relative to the working directory', async () => {
      files = [yamlFile('en', '  a: "A"\n', 'i18n'), yamlFile('sv', '  a: "A-sv"\n', 'i18n')];
      const checkDeps = deps();

      await runCheck({ path: `${process.cwd()}/i18n` }, checkDeps as never);

      expect(checkDeps.fsUtils.listFiles).toHaveBeenCalledWith(['i18n/'], '**/*.{json,yml,yaml,po,pot}', []);
    });

    it('does not count a source file the locale has no file for as missing keys', async () => {
      files = [
        yamlFile('en', '  a: "A"\n'),
        yamlFile('en', '  p: "P"\n', 'config/locales/pressroom'),
        yamlFile('sv', '  p: "P-sv"\n', 'config/locales/pressroom')
      ];

      const { exitCode, reports } = await run();

      expect(reports[0].missing).toEqual([]);
      expect(reports[0].missingFiles).toEqual(['config/locales/en.yml']);
      expect(exitCode).toBe(0);
    });

    it('says so when only one language is found', async () => {
      files = [yamlFile('sv', '  a: "A"\n')];

      const { exitCode } = await run();

      expect(exitCode).toBe(0);
      expect(printed()).toContain('Only sv found');
      expect(printed()).not.toMatch(/guess/i);
      expect(printed()).not.toContain('Locale        Keys');
    });

    it('stops with a pointer to --path when nothing is found', async () => {
      const { exitCode } = await run();

      expect(exitCode).toBe(1);
      expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('--path'));
    });

    it('reports what was detected in --json', async () => {
      files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];

      await check({ json: true }, deps() as never);

      expect(JSON.parse(printed()).detected).toEqual({
        source: 'en',
        reason: 'en',
        paths: ['config/locales/'],
        pattern: '**/*.{yml,yaml}',
        excluded: []
      });
    });
  });

  describe('in CI', () => {
    const PR_ENV = {
      GITHUB_ACTIONS: 'true',
      GITHUB_BASE_REF: 'main',
      GITHUB_SHA: 'merge',
      GITHUB_STEP_SUMMARY: '/summary.md'
    };
    const BASE = 'base0000000';

    function textOf(file: TranslationFile): string {
      return Buffer.from(file.content ?? '', 'base64').toString('utf8');
    }

    function filesOf(...versions: TranslationFile[]): Record<string, string> {
      return Object.fromEntries(versions.map((file) => [file.path, textOf(file)]));
    }

    function onBase(...versions: TranslationFile[]): void {
      git = fakeGit({ head: 'merge', headParents: [BASE, 'pr'], commits: new Set([BASE]), files: { [BASE]: filesOf(...versions) } });
    }

    function annotations(): string[] {
      return printed().split('\n').filter((line) => line.startsWith('::'));
    }

    function summary(): string {
      return appendFile.mock.calls.map((call) => String(call[1])).join('');
    }

    beforeEach(() => {
      env = { ...PR_ENV };
    });

    describe('on a pull request', () => {
      beforeEach(() => {
        onBase(yamlFile('en', '  old: "Old"\n'), yamlFile('sv', '  other: "Annan"\n'));
        files = [yamlFile('en', '  old: "Old"\n  new: "New"\n'), yamlFile('sv', '  other: "Annan"\n')];
      });

      it('annotates and fails on a key the pull request added without a translation', async () => {
        await check({}, deps() as never);

        expect(process.exitCode).toBe(1);
        expect(annotations()).toEqual(['::error file=config/locales/en.yml,line=3::Missing translation for "new" (locale sv)']);
      });

      it('leaves a missing translation the base already had to the job summary', async () => {
        await check({}, deps() as never);

        expect(printed()).not.toContain('"old"');
        expect(appendFile).toHaveBeenCalledWith('/summary.md', expect.any(String));
        expect(summary()).toContain('Missing translation for "new" (locale sv)');
        expect(summary()).toContain('| sv | 1 | 0 | 0 | 0 | 0 | 1 |');
        expect(summary()).toContain('https://localhero.ai');
      });

      it('passes when the pull request adds no problems', async () => {
        files = [yamlFile('en', '  old: "Old"\n'), yamlFile('sv', '  other: "Annan"\n')];

        await check({}, deps() as never);

        expect(process.exitCode).toBe(0);
        expect(annotations()).toEqual([]);
        expect(summary()).toContain('No problems in changed keys');
      });

      it('fetches the base commit a depth-1 checkout lacks', async () => {
        git = fakeGit({
          head: 'merge',
          headParents: [BASE, 'pr'],
          fetchable: new Set([BASE]),
          files: { [BASE]: filesOf(yamlFile('en', '  old: "Old"\n'), yamlFile('sv', '  other: "Annan"\n')) }
        });

        await check({}, deps() as never);

        expect(git.calls).toContainEqual(['fetch', '--no-tags', '--depth=1', 'origin', BASE]);
        expect(process.exitCode).toBe(1);
        expect(annotations()).toEqual(['::error file=config/locales/en.yml,line=3::Missing translation for "new" (locale sv)']);
      });

      it('checks every key without failing on them when it cannot compare with the base', async () => {
        git = fakeGit({ head: 'merge', headParents: [BASE, 'pr'] });

        await check({}, deps() as never);

        expect(process.exitCode).toBe(0);
        expect(annotations()).toEqual([expect.stringMatching(/^::warning::Could not compare with the base.*fetch-depth: 0/)]);
        expect(summary()).toContain('Could not compare with the base');
        expect(summary()).toContain('| sv | 2 |');
      });

      it('still fails on a file it cannot parse when it cannot compare with the base', async () => {
        git = fakeGit({ head: 'merge', headParents: [BASE, 'pr'] });
        parseFailures = [{ path: 'config/locales/de.yml', error: 'bad indentation' }];

        await check({}, deps() as never);

        expect(process.exitCode).toBe(1);
      });

      it('checks every key with --full', async () => {
        await check({ full: true }, deps() as never);

        expect(process.exitCode).toBe(1);
        expect(annotations()).toHaveLength(3);
        expect(git.calls).toEqual([]);
      });

      it('rejects --changed-only together with --full', async () => {
        const { exitCode } = await run({ changedOnly: true, full: true });

        expect(exitCode).toBe(1);
        expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('--full'));
      });

      it('prints JSON with --json, marking which findings the pull request introduced', async () => {
        await check({ json: true }, deps() as never);

        const report = JSON.parse(printed());
        expect(report.changedOnly).toEqual({ base: `main (${BASE.slice(0, 7)})`, diffAvailable: true });
        expect(report.locales[0].missing.map((m: { key: string; introduced: boolean }) => [m.key, m.introduced])).toEqual([
          ['old', false],
          ['new', true]
        ]);
        expect(process.exitCode).toBe(1);
      });

      it('reports in JSON that the diff was unavailable', async () => {
        git = fakeGit({ head: 'merge', headParents: [BASE, 'pr'] });

        await check({ json: true }, deps() as never);

        const report = JSON.parse(printed());
        expect(report.changedOnly).toEqual({ base: null, diffAvailable: false, reason: expect.stringContaining(BASE.slice(0, 7)) });
        expect(report.locales[0].missing[0].introduced).toBeUndefined();
        expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('Could not compare with the base'));
      });

      it('checks every key when git cannot read a file at the base commit', async () => {
        git = fakeGit({ head: 'merge', headParents: [BASE, 'pr'], commits: new Set([BASE]) });

        await check({}, deps() as never);

        expect(process.exitCode).toBe(0);
        expect(annotations()).toEqual([expect.stringMatching(/^::warning::Could not compare with the base branch: git could not read/)]);
      });

      it('prints the human report with --format text', async () => {
        await check({ format: 'text' }, deps() as never);

        expect(annotations()).toEqual([]);
        expect(printed()).toContain('Missing keys (1):\n  new');
        expect(printed()).toContain('2 problems in keys that did not change');
      });

      it('writes no summary without GITHUB_STEP_SUMMARY', async () => {
        delete env.GITHUB_STEP_SUMMARY;

        await check({}, deps() as never);

        expect(appendFile).not.toHaveBeenCalled();
      });

      it('does not fail the run when the summary cannot be written', async () => {
        appendFile.mockImplementation(() => {
          throw new Error('EACCES');
        });

        await check({}, deps() as never);

        expect(process.exitCode).toBe(1);
        expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
      });
    });

    describe('--fail-on', () => {
      beforeEach(() => {
        onBase(yamlFile('en', '  old: "Old"\n  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej"\n'));
      });

      it('ignores an existing placeholder mismatch with --fail-on placeholders', async () => {
        files = [yamlFile('en', '  old: "Old"\n  hi: "Hi %{name}"\n  new: "New"\n'), yamlFile('sv', '  hi: "Hej"\n')];

        expect((await run({ failOn: 'placeholders' })).exitCode).toBe(0);
      });

      it('fails on a placeholder mismatch the pull request made in a translation', async () => {
        onBase(yamlFile('en', '  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej %{name}"\n'));
        files = [yamlFile('en', '  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej {name}"\n')];

        expect((await run({ failOn: 'placeholders' })).exitCode).toBe(1);
      });

      it('fails on a placeholder the pull request added to the source', async () => {
        onBase(yamlFile('en', '  bye: "Bye"\n'), yamlFile('sv', '  bye: "Hejdå"\n'));
        files = [yamlFile('en', '  bye: "Bye %{name}"\n'), yamlFile('sv', '  bye: "Hejdå"\n')];

        expect((await run({ failOn: 'placeholders' })).exitCode).toBe(1);
      });

      it('ignores existing findings with --fail-on any', async () => {
        files = [yamlFile('en', '  old: "Old"\n  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej"\n')];

        expect((await run({ failOn: 'any' })).exitCode).toBe(0);
      });

      it('never fails with --fail-on none', async () => {
        files = [yamlFile('en', '  old: "Old"\n  hi: "Hi %{name}"\n  new: "New"\n'), yamlFile('sv', '  hi: "Hej"\n')];

        expect((await run({ failOn: 'none' })).exitCode).toBe(0);
      });
    });

    it('counts a translation the pull request removed or emptied as its own', async () => {
      onBase(yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  a: "A-sv"\n  b: "B-sv"\n'));
      files = [yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  b: ""\n')];

      const { exitCode, reports } = await run();

      expect(exitCode).toBe(1);
      expect(reports[0].missing).toEqual([expect.objectContaining({ key: 'a', introduced: true })]);
      expect(reports[0].empty).toEqual([expect.objectContaining({ key: 'b', introduced: true })]);
    });

    it('does not blame a pull request that only moved a file for its existing problems', async () => {
      const moved = 'config/locales/app';
      git = fakeGit({
        head: 'merge',
        headParents: [BASE, 'pr'],
        commits: new Set([BASE]),
        files: { [BASE]: filesOf(yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  a: "A-sv"\n')) },
        renames: { [`${moved}/en.yml`]: 'config/locales/en.yml', [`${moved}/sv.yml`]: 'config/locales/sv.yml' }
      });
      files = [yamlFile('en', '  a: "A"\n  b: "B"\n', moved), yamlFile('sv', '  a: "A-sv"\n', moved)];

      const { exitCode, reports } = await run();

      expect(exitCode).toBe(0);
      expect(reports[0].missing).toEqual([expect.objectContaining({ key: 'b', introduced: false })]);
    });

    it('says what a placeholder mismatch is about', async () => {
      onBase(yamlFile('en', '  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej %{name}"\n'));
      files = [yamlFile('en', '  hi: "Hi %{name}"\n'), yamlFile('sv', '  hi: "Hej {name}"\n')];

      await check({}, deps() as never);

      expect(annotations()).toEqual([
        '::error file=config/locales/sv.yml,line=2::Placeholder mismatch for "hi" (locale sv): missing %25{name}, unexpected {name}'
      ]);
    });

    it('matches Rails plural forms the target language adds to a group the pull request added', async () => {
      config.outputLocales = ['pl'];
      const plFiles = '  files:\n    one: "%{count} plik"\n    other: "%{count} pliki"\n';
      const enFiles = '  files:\n    one: "%{count} file"\n    other: "%{count} files"\n';
      onBase(yamlFile('en', enFiles), yamlFile('pl', plFiles));
      files = [
        yamlFile('en', `${enFiles}  items:\n    one: "%{count} item"\n    other: "%{count} items"\n`),
        yamlFile('pl', plFiles)
      ];

      const { exitCode, reports } = await run();

      expect(exitCode).toBe(1);
      expect(reports[0].missing.length).toBeGreaterThan(0);
      expect(reports[0].missing.every((m) => m.introduced)).toBe(true);
      expect(reports[0].missingPluralCategories).toEqual([expect.objectContaining({ key: 'files', introduced: false })]);
    });

    it('matches PO keys with context and plural forms', async () => {
      config.translationFiles = { paths: ['locale/'] };
      const old = 'msgid "Old"\nmsgstr "Old"\n\n';
      const added =
        'msgctxt "menu"\nmsgid "Open"\nmsgstr "Open"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] "%d file"\nmsgstr[1] "%d files"\n';
      onBase(poFile('en', old), poFile('sv', ''));
      files = [poFile('en', old + added), poFile('sv', '')];

      const { reports } = await run();

      expect(reports[0].missing.map((m) => [m.key, m.introduced])).toEqual([
        ['Old', false],
        ['%d file', true],
        ['%d file__plural_1', true],
        ['menu|Open', true]
      ]);
    });

    it('keeps the locales of a multi-language file apart', async () => {
      config.outputLocales = ['sv', 'de'];
      const multiFile = (locale: string, sv: string, de: string): TranslationFile => ({
        path: 'app/views/welcome.i18n.yml',
        format: 'yml',
        locale,
        content: Buffer.from(`en:\n  hi: "Hi %{name}"\nsv:\n  hi: "${sv}"\nde:\n  hi: "${de}"\n`).toString('base64'),
        multiLanguage: true
      });
      onBase(multiFile('en', 'Hej', 'Hallo %{name}'));
      files = ['en', 'sv', 'de'].map((locale) => multiFile(locale, 'Hej', 'Hallo'));

      const { reports } = await run({ failOn: 'placeholders' });

      const byLocale = Object.fromEntries(reports.map((r) => [r.locale, r.placeholderMismatches.map((m) => m.introduced)]));
      expect(byLocale).toEqual({ sv: [false], de: [true] });
    });

    it('prints annotations and checks every key on a GitHub run outside a pull request', async () => {
      env = { GITHUB_ACTIONS: 'true' };
      files = [yamlFile('en', '  a: "A"\n  b: "B"\n'), yamlFile('sv', '  a: "A-sv"\n')];

      await check({}, deps() as never);

      expect(process.exitCode).toBe(1);
      expect(annotations()).toEqual(['::error file=config/locales/en.yml,line=3::Missing translation for "b" (locale sv)']);
      expect(git.calls).toEqual([]);
    });

    it('keeps discovery notices out of GitHub annotation output', async () => {
      env = { GITHUB_ACTIONS: 'true' };
      files = [yamlFile('en', '  a: "A"\n'), yamlFile('sv', '  a: "A-sv"\n')];
      const checkDeps = deps();

      await check({}, checkDeps as never);

      const { logger } = checkDeps.fileUtils.findTranslationFiles.mock.calls[0][1] as { logger?: { log: (m: string) => void } };
      logger?.log('ℹ Multi-language files: beta feature');
      expect(logger).toBeDefined();
      expect(printed()).not.toContain('beta');
    });

    it('compares with the base branch on --changed-only outside CI', async () => {
      env = {};
      git = fakeGit({
        refs: { main: 'tip' },
        mergeBases: { main: 'fork' },
        files: { fork: filesOf(yamlFile('en', '  old: "Old"\n'), yamlFile('sv', '')) }
      });
      files = [yamlFile('en', '  old: "Old"\n  new: "New"\n'), yamlFile('sv', '')];

      await check({ changedOnly: true }, deps() as never);

      expect(process.exitCode).toBe(1);
      expect(printed()).toContain('Missing keys (1):\n  new');
      expect(printed()).not.toContain('::');
    });
  });
});
