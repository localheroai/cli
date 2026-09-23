import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { runCheck, check, CheckOptions } from '../../src/commands/check.js';
import type { TranslationConfig, TranslationFile } from '../../src/types/index.js';

function yamlFile(locale: string, body: string, dir = 'config/locales'): TranslationFile {
  return {
    path: `${dir}/${locale}.yml`,
    format: 'yml',
    locale,
    content: Buffer.from(`${locale}:\n${body}`).toString('base64')
  };
}

function poFile(locale: string, body: string): TranslationFile {
  const header = `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: ${locale}\\n"\n\n`;
  return {
    path: `locale/${locale}.po`,
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
    process.exitCode = undefined;
  });

  function deps() {
    return {
      console: mockConsole,
      configUtils: { getProjectConfig: jest.fn(async () => config) },
      fileUtils: {
        findTranslationFiles: jest.fn(async () => ({
          allFiles: files,
          sourceFiles: files.filter((f) => f.locale === config.sourceLocale),
          targetFilesByLocale: Object.fromEntries(
            config.outputLocales.map((l) => [l, files.filter((f) => f.locale === l)])
          ),
          parseFailures
        }))
      }
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
      '::error file=locale/sv.po::Missing translation for "Line one%0ALine two: 100%25" (locale sv)'
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
      '::error file=config/locales/sv.yml::"title" has different values in config/locales/sv.yml, config/locales/pages/sv.yml (locale sv)'
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
});
