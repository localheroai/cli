import type { ChangeStatus } from './check-changes.js';

export interface SummaryProblem {
  locale: string;
  file: string;
  message: string;
}

export interface ProblemCounts {
  missing: number;
  placeholders: number;
  plurals: number;
  structure: number;
  conflicts: number;
  orphans: number;
}

export interface StepSummaryInput {
  changes: ChangeStatus;
  problems: SummaryProblem[];
  /** Problems in unchanged keys, or every problem when the comparison failed. */
  counts: { locale: string; counts: ProblemCounts }[];
  missingTranslations: boolean;
}

const MAX_LISTED_PROBLEMS = 50;
const COLUMNS: [keyof ProblemCounts, string][] = [
  ['missing', 'Missing'],
  ['placeholders', 'Placeholders'],
  ['plurals', 'Plural forms'],
  ['structure', 'Structure'],
  ['conflicts', 'Conflicts'],
  ['orphans', 'Orphans']
];

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

function statusLine(input: StepSummaryInput): string {
  const { changes, problems } = input;
  if (changes === null) return problems.length ? `${plural(problems.length, 'problem')} found.` : 'No problems found.';
  if ('error' in changes) {
    return [
      '> [!WARNING]',
      `> Could not compare with the base branch: ${escapeMarkdown(changes.error)}.`,
      '> Checked every key instead. These problems do not fail the check.',
      '> Check out with `fetch-depth: 0` in actions/checkout if this keeps happening.'
    ].join('\n');
  }
  const found = problems.length ? `${plural(problems.length, 'problem')} in changed keys.` : 'No problems in changed keys.';
  return `Compared with \`${changes.base}\`: ${found}`;
}

function problemList(problems: SummaryProblem[]): string[] {
  const shown = problems.slice(0, MAX_LISTED_PROBLEMS);
  const lines: string[] = [];
  for (const locale of new Set(shown.map((p) => p.locale))) {
    lines.push(`#### ${locale}`, '');
    for (const problem of shown.filter((p) => p.locale === locale)) {
      lines.push(`- ${escapeMarkdown(problem.message)} in \`${problem.file}\``);
    }
    lines.push('');
  }
  if (problems.length > shown.length) {
    lines.push(`${problems.length - shown.length} more not shown. Run check --json for the full report.`, '');
  }
  return lines;
}

function countsTable(counts: StepSummaryInput['counts']): string[] {
  const rows = counts.filter(({ counts: c }) => COLUMNS.some(([column]) => c[column] > 0));
  if (rows.length === 0) return [];
  return [
    `| Locale | ${COLUMNS.map(([, title]) => title).join(' | ')} |`,
    `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map(({ locale, counts: c }) => `| ${locale} | ${COLUMNS.map(([column]) => c[column]).join(' | ')} |`),
    ''
  ];
}

export function buildStepSummary(input: StepSummaryInput): string {
  const lines = ['## Translation check', '', statusLine(input), '', ...problemList(input.problems)];
  const table = countsTable(input.counts);
  if (table.length && input.changes && 'base' in input.changes) {
    lines.push('### Existing problems', '', 'In keys that did not change. They do not fail the check.', '', ...table);
  } else if (table.length && input.changes) {
    lines.push('### Problems found', '', ...table);
  }
  if (input.missingTranslations) {
    lines.push('Localhero.ai can fill missing translations automatically: https://localhero.ai', '');
  }
  return lines.join('\n');
}
