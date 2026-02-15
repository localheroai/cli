import chalk from 'chalk';
import { fetchSettings as defaultFetchSettings } from '../api/settings.js';
import { configService } from '../utils/config.js';
import { checkAuth as defaultCheckAuth } from '../utils/auth.js';
import type { SettingsResponse } from '../api/settings.js';

export interface SettingsOptions {
  output?: string;
}

interface SettingsDependencies {
  console?: Pick<Console, 'log' | 'error'>;
  configUtils?: typeof configService;
  authUtils?: { checkAuth: typeof defaultCheckAuth };
  fetchSettings?: typeof defaultFetchSettings;
}

export async function settings(options: SettingsOptions, deps: SettingsDependencies = {}): Promise<void> {
  const {
    console: con = global.console,
    configUtils = configService,
    authUtils = { checkAuth: defaultCheckAuth },
    fetchSettings = defaultFetchSettings
  } = deps;

  const isAuthenticated = await authUtils.checkAuth();
  if (!isAuthenticated) {
    con.error(chalk.red('Not authenticated. Run `localhero login` first.'));
    process.exit(1);
    return;
  }

  const config = await configUtils.getValidProjectConfig();

  const data: SettingsResponse = await fetchSettings(config.projectId);
  const projectSettings = data.settings;

  if (options.output === 'json') {
    con.log(JSON.stringify(data));
    return;
  }

  con.log(chalk.bold(`Project: ${projectSettings.name}`));
  if (projectSettings.tone_of_voice) con.log(`Tone:    ${projectSettings.tone_of_voice}`);
  if (projectSettings.content_type) con.log(`Type:    ${projectSettings.content_type}`);
  if (projectSettings.length_preference) con.log(`Length:  ${projectSettings.length_preference.replace(/_/g, ' ')}`);
  if (projectSettings.gender_handling) con.log(`Gender:  ${projectSettings.gender_handling}`);
  if (projectSettings.brand_name) con.log(`Brand:   ${projectSettings.brand_name}`);
  if (projectSettings.style_guide) {
    con.log(`Style:   ${projectSettings.style_guide}`);
  }

  con.log('');
  con.log(`Source:  ${projectSettings.source_language.name} (${projectSettings.source_language.code})`);

  if (projectSettings.target_languages.length > 0) {
    const targets = projectSettings.target_languages.map(l => `${l.name} (${l.code})`).join(', ');
    con.log(`Targets: ${targets}`);
  }
}
