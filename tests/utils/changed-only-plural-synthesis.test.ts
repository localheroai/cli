import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { filterByGitChanges } from '../../src/utils/git-changes.js';
import { findMissingTranslationsByLocale } from '../../src/utils/translation-utils.js';
import type { ProjectConfig, TranslationFile } from '../../src/types/index.js';

/**
 * Composes plural-category synthesis (#636) with --changed-only filtering.
 *
 * The two were correct in isolation but not together: synthesis produced the
 * categories the locale needs and the filter threw them away, because its
 * plural rescue only understood gettext's `__plural_N` suffix.
 */
describe('--changed-only over synthesised plural categories', () => {
  let repo: string;
  let originalCwd: string;

  const config = {
    schemaVersion: '1.0',
    projectId: 'test',
    sourceLocale: 'en',
    outputLocales: ['pl'],
    translationFiles: { paths: ['config/locales/'], baseBranch: 'HEAD' },
    localePluralCategories: { pl: ['one', 'few', 'many', 'other'] },
    lastSyncedAt: null
  } as unknown as ProjectConfig;

  const sourcePath = 'config/locales/en.yml';
  const targetPath = 'config/locales/pl.yml';

  function asTranslationFile(filePath: string, locale: string): TranslationFile {
    return {
      path: filePath,
      format: 'yml',
      locale,
      content: readFileSync(filePath).toString('base64')
    } as TranslationFile;
  }

  function commitBase(files: Record<string, string>) {
    for (const [filePath, body] of Object.entries(files)) {
      execSync(`mkdir -p ${path.dirname(filePath)}`);
      writeFileSync(filePath, body);
    }
    execSync('git add .');
    execSync('git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm base');
  }

  function write(files: Record<string, string>) {
    for (const [filePath, body] of Object.entries(files)) {
      execSync(`mkdir -p ${path.dirname(filePath)}`);
      writeFileSync(filePath, body);
    }
  }

  function synthesiseThenFilter() {
    const sourceFiles = [asTranslationFile(sourcePath, 'en')];
    const { missing } = findMissingTranslationsByLocale(
      sourceFiles,
      { pl: [asTranslationFile(targetPath, 'pl')] },
      config as any,
      false,
      { log: () => {} }
    );

    const beforeFilter = Object.keys(missing[`pl:${sourcePath}`]?.keys ?? {}).sort();
    const filtered = filterByGitChanges(sourceFiles, missing, config, false);
    const afterFilter = Object.keys(filtered?.[`pl:${sourcePath}`]?.keys ?? {}).sort();

    return { beforeFilter, afterFilter };
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(path.join(os.tmpdir(), 'changed-only-plurals-'));
    process.chdir(repo);
    execSync('git init -q');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps every synthesised category when a plural group is added in the PR', () => {
    commitBase({
      [sourcePath]: 'en:\n  greeting: Hello\n',
      [targetPath]: 'pl:\n  greeting: Czesc\n'
    });

    write({
      [sourcePath]: 'en:\n  greeting: Hello\n  milestone_count:\n    one: 1 milestone\n    other: "%{count} milestones"\n',
      [targetPath]: 'pl:\n  greeting: Czesc\n'
    });

    const { beforeFilter, afterFilter } = synthesiseThenFilter();

    expect(beforeFilter).toEqual([
      'milestone_count.few',
      'milestone_count.many',
      'milestone_count.one',
      'milestone_count.other'
    ]);
    expect(afterFilter).toEqual(beforeFilter);
  });

  it('keeps few/many when the source text is reworded and one/other are already translated', () => {
    commitBase({
      [sourcePath]: 'en:\n  milestone_count:\n    one: 1 milestone\n    other: "%{count} milestones"\n',
      [targetPath]: 'pl:\n  milestone_count:\n    one: 1 kamien\n    other: "%{count} kamieni"\n'
    });

    write({
      [sourcePath]: 'en:\n  milestone_count:\n    one: 1 milestone reached\n    other: "%{count} milestones reached"\n'
    });

    const { beforeFilter, afterFilter } = synthesiseThenFilter();

    // one/other are already present in pl.yml, so synthesis asks only for the
    // categories Polish adds. Before the fix the filter dropped both and
    // translate reported "No changed keys need translation".
    expect(beforeFilter).toEqual(['milestone_count.few', 'milestone_count.many']);
    expect(afterFilter).toEqual(['milestone_count.few', 'milestone_count.many']);
  });

  it('does not rescue a lone dotted key that only looks like a plural category', () => {
    commitBase({
      [sourcePath]: 'en:\n  greeting: Hello\n  errors:\n    other: Something went wrong\n    detail: Details\n',
      [targetPath]: 'pl:\n  greeting: Czesc\n  errors:\n    other: Blad\n    detail: Szczegoly\n'
    });

    // greeting is reworded, and both it and errors.other are untranslated in pl.
    write({
      [sourcePath]: 'en:\n  greeting: Hi there\n  errors:\n    other: Something went wrong\n    detail: Details\n',
      [targetPath]: 'pl:\n  errors:\n    detail: Szczegoly\n'
    });

    const { afterFilter } = synthesiseThenFilter();

    // `errors.other` has no sibling CLDR category, so it is not a plural group:
    // changing `greeting` must not pull it in.
    expect(afterFilter).toEqual(['greeting']);
  });
});
