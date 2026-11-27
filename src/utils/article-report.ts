import chalk from 'chalk';
import { escapeAnnotationData } from './ci-context.js';
import type { DocumentOutcome, DocumentResult } from './translation-processor.js';
import type { DocumentRefusal } from './documents.js';

const SKIPPED_FOR_UPDATES = 'new_language_waits_for_updates';

type Logger = Pick<Console, 'log' | 'error'>;

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function byStatus(result: DocumentResult, status: DocumentOutcome['status']): DocumentOutcome[] {
  return result.outcomes.filter(outcome => outcome.status === status);
}

// What happened to each article in a run, in the CI log. A refused article is a warning; a failed
// one is an error and fails the run.
export function articleReporter(console: Logger) {
  function annotate(level: 'warning' | 'error', text: string): void {
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::${level}::${escapeAnnotationData(text)}`);
    } else if (level === 'error') {
      console.error(chalk.red(`✖ ${text}`));
    } else {
      console.log(chalk.yellow(`⚠ ${text}`));
    }
  }

  function reportRefusedArticles(refused: DocumentRefusal[]): void {
    for (const { path, reason } of refused) {
      annotate('warning', `Article skipped: ${path}, ${reason}`);
    }
  }

  function reportArticles(documentResult: DocumentResult): void {
    const written = byStatus(documentResult, 'written');
    if (written.length > 0) {
      const articles = new Set(written.map(outcome => outcome.path)).size;
      const languages = [...new Set(written.map(outcome => outcome.locale))];
      console.log(`» Translated ${pluralize(articles, 'article')} in ${languages.join(', ')}`);
    }

    for (const { path, locale, reason } of byStatus(documentResult, 'skipped')) {
      console.log(chalk.blue(reason === SKIPPED_FOR_UPDATES
        ? `ℹ Not translated yet: ${path} (${locale}). New languages for existing articles come with article updates.`
        : `ℹ Not translated: ${path} (${locale}), ${reason}`));
    }
    for (const { path, locale, reason } of byStatus(documentResult, 'refused')) {
      annotate('warning', `Article skipped: ${path} (${locale}), ${reason}`);
    }
    for (const { path, locale, reason } of byStatus(documentResult, 'failed')) {
      annotate('error', `Article not translated: ${path} (${locale}), ${reason}`);
    }

    const notSent = new Set(byStatus(documentResult, 'not_sent').map(outcome => outcome.path)).size;
    if (documentResult.stopped && notSent > 0) {
      const verb = notSent === 1 ? 'was' : 'were';
      annotate('error', `${pluralize(notSent, 'article')} ${verb} not translated: ${documentResult.stopped.message}`);
    }
  }

  return { reportArticles, reportRefusedArticles };
}
