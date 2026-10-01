import { readFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { parseFile, flattenTranslations } from './files.js';
import { extractLocaleContent } from './git-changes.js';
import type { AlignedCell, Logger } from './source-alignment.js';

/**
 * Keep only the aligned cells whose value and source text are still in the
 * files as they were aligned. A postTranslateCommand can reformat or drop a
 * value, and Localhero must not stage a value the commit doesn't contain.
 */
export function keepAlignedCellsOnDisk(cells: AlignedCell[], sourceLocale: string, logger: Logger): AlignedCell[] {
  const valuesByFile = new Map<string, Record<string, unknown> | null>();
  const valuesFor = (filePath: string, locale: string) => {
    const id = `${locale}\0${filePath}`;
    if (!valuesByFile.has(id)) {
      valuesByFile.set(id, readValues(filePath, locale));
    }
    return valuesByFile.get(id);
  };

  const kept = cells.filter((cell) =>
    valuesFor(cell.target_path, cell.locale)?.[cell.key] === cell.value &&
    valuesFor(cell.source_path, sourceLocale)?.[cell.key] === cell.source
  );

  const dropped = cells.length - kept.length;
  if (dropped > 0) {
    const noun = dropped === 1 ? 'value' : 'values';
    logger.log(chalk.dim(`» ${dropped} aligned ${noun} changed after they were written (postTranslateCommand?); not sent for review`));
  }
  return kept;
}

function readValues(filePath: string, locale: string): Record<string, unknown> | null {
  try {
    const format = path.extname(filePath).slice(1);
    const parsed = parseFile(readFileSync(filePath, 'utf-8'), format, filePath);
    return flattenTranslations(extractLocaleContent(parsed, locale));
  } catch {
    return null;
  }
}
