import chalk from 'chalk';
import type { IgnoreSummary } from './ignore-keys.js';

export function logIgnoreSummary(
  summary: IgnoreSummary,
  logger: { log: (message: string) => void }
): void {
  if (summary.totalKeysIgnored > 0) {
    logger.log(
      chalk.blue(
        `ℹ Ignored ${summary.totalKeysIgnored} keys matching ignoreKeys patterns:`
      )
    );
    for (const p of summary.perPattern) {
      if (p.count === 0) continue;
      const example = p.example ? ` (e.g., ${p.example})` : '';
      logger.log(chalk.dim(`  ${p.pattern} → ${p.count} keys${example}`));
    }
  }
  if (summary.totalTargetTranslationsIgnored > 0) {
    const perLocale = Object.entries(summary.targetTranslationsPerLocale)
      .map(([l, n]) => `${l}: ${n}`)
      .join(', ');
    logger.log(
      chalk.blue(
        `ℹ ${summary.totalTargetTranslationsIgnored} target translations for ignored keys were also filtered (${perLocale})`
      )
    );
  }
  for (const stale of summary.zeroMatchPatterns) {
    logger.log(
      chalk.yellow(
        `⚠ Pattern "${stale}" in ignoreKeys matched no keys. It may be stale.`
      )
    );
  }
}
