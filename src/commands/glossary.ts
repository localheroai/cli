import chalk from 'chalk';
import { fetchGlossaryTerms as defaultFetchGlossaryTerms } from '../api/glossary.js';
import { configService } from '../utils/config.js';
import { checkAuth as defaultCheckAuth } from '../utils/auth.js';
import type { GlossaryResponse } from '../api/glossary.js';

export interface GlossaryOptions {
  output?: string;
  search?: string;
}

interface GlossaryDependencies {
  console?: Pick<Console, 'log' | 'error'>;
  configUtils?: typeof configService;
  authUtils?: { checkAuth: typeof defaultCheckAuth };
  fetchGlossaryTerms?: typeof defaultFetchGlossaryTerms;
}

export async function glossary(options: GlossaryOptions, deps: GlossaryDependencies = {}): Promise<void> {
  const {
    console: con = global.console,
    configUtils = configService,
    authUtils = { checkAuth: defaultCheckAuth },
    fetchGlossaryTerms = defaultFetchGlossaryTerms
  } = deps;

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    con.error(chalk.red('Not authenticated. Run `localhero login` first.'));
    process.exit(1);
    return;
  }

  const config = await configUtils.getValidProjectConfig();

  const data: GlossaryResponse = await fetchGlossaryTerms(config.projectId, options.search);
  const terms = data.glossary_terms;

  if (options.output === 'json') {
    con.log(JSON.stringify(data));
    return;
  }

  if (terms.length === 0) {
    con.log(chalk.dim(options.search
      ? `No glossary terms matching "${options.search}".`
      : 'No glossary terms configured for this project.'
    ));
    return;
  }

  const header = options.search
    ? `Glossary terms matching "${options.search}" (${terms.length}):`
    : `Project glossary (${terms.length} terms):`;

  con.log(chalk.bold(header));
  con.log('');

  for (const term of terms) {
    const context = term.context ? chalk.dim(`"${term.context}"`) : '';
    con.log(`  ${chalk.white(padRight(term.term, 20))} ${chalk.cyan(padRight(term.translation_strategy || 'Default', 20))} ${context}`);
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}
