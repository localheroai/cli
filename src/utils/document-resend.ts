import { execFileSync } from 'child_process';
import type { ProjectConfig, TranslationFile } from '../types/index.js';
import type { MissingLocaleEntry } from './translation-utils.js';
import { findMissingDocuments } from './documents.js';
import { flatValuesAt, getBaseBranch, isGitAvailable, resolveCompareRef } from './git-changes.js';
import { TRANSLATE_COMMIT_SUBJECT } from './github.js';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
}

// The newest commit of ours on this branch that wrote the target. A sync commit does not count:
// it writes the text Localhero holds, which says nothing about the English it was made from.
// Neither does a commit from before the branch: it belongs to an earlier article of the same name.
function lastTranslateCommit(targetPath: string, mergeBase: string): string | null {
  const commits = git(['log', '--format=%H%x00%s', `${mergeBase}..HEAD`, '--', targetPath]).split('\n').map(line => line.split('\0'));
  const ours = commits.find(([, subject]) => subject === TRANSLATE_COMMIT_SUBJECT);
  return ours ? ours[0] : null;
}

function hasUncommittedChanges(targetPath: string): boolean {
  return git(['status', '--porcelain', '--', targetPath]).trim() !== '';
}

/**
 * A new article whose English changed again in the same pull request. Its
 * translation exists, so nothing is missing, yet it was made from an older
 * text. The English is sent again when it differs from the English at our last
 * translation commit for that target.
 *
 * Whenever that cannot be told (no such commit, uncommitted changes, git
 * failing) nothing is sent: a stale translation is better than replacing
 * someone's text over an English that did not change.
 */
export function findDocumentsToResend(
  sourceFiles: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: ProjectConfig
): Record<string, MissingLocaleEntry> {
  const sourceDocuments = sourceFiles.filter(file => file.documentFormat);
  if (sourceDocuments.length === 0 || !isGitAvailable()) return {};

  const mergeBase = resolveCompareRef(getBaseBranch(config));
  if (!mergeBase) return {};

  const withoutTargets = Object.fromEntries(config.outputLocales.map(locale => [locale, []]));
  const translated = (entry: MissingLocaleEntry): boolean =>
    (targetFilesByLocale[entry.locale] ?? []).some(file => file.path === entry.targetPath);
  const resend: Record<string, MissingLocaleEntry> = {};

  for (const source of sourceDocuments) {
    try {
      if (flatValuesAt(source, mergeBase) !== null) continue;

      const candidates = findMissingDocuments([source], withoutTargets, config);
      for (const [entryKey, entry] of Object.entries(candidates)) {
        if (!translated(entry) || hasUncommittedChanges(entry.targetPath)) continue;

        const commit = lastTranslateCommit(entry.targetPath, mergeBase);
        const [name, current] = Object.entries(entry.keys)[0];
        const madeFrom = commit ? flatValuesAt(source, commit)?.[name] : undefined;
        if (typeof madeFrom === 'string' && madeFrom !== current.value) {
          resend[entryKey] = entry;
        }
      }
    } catch {
      continue;
    }
  }

  return resend;
}
