import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { settings, SettingsOptions } from '../../src/commands/settings.js';

describe('settings command', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock };
  let mockConfigUtils: any;
  let mockAuthUtils: { checkAuth: jest.Mock };
  let mockFetchSettings: jest.Mock;

  const sampleSettings = {
    settings: {
      name: 'FitFlow',
      brand_name: 'FitFlow',
      tone_of_voice: 'casual',
      content_type: 'interface',
      length_preference: 'natural',
      gender_handling: 'neutral',
      style_guide: 'Use active voice. Avoid jargon.',
      source_language: { code: 'en', name: 'English' },
      target_languages: [
        { code: 'sv', name: 'Swedish' },
        { code: 'de', name: 'German' }
      ]
    }
  };

  beforeEach(() => {
    mockConsole = {
      log: jest.fn(),
      error: jest.fn()
    };

    mockConfigUtils = {
      getValidProjectConfig: jest.fn().mockResolvedValue({
        projectId: 'test-project',
        sourceLocale: 'en',
        outputLocales: ['sv', 'de']
      })
    };

    mockAuthUtils = {
      checkAuth: jest.fn().mockResolvedValue(true)
    };

    mockFetchSettings = jest.fn().mockResolvedValue(sampleSettings);
  });

  function runSettings(options: SettingsOptions = {}) {
    return settings(options, {
      console: mockConsole,
      configUtils: mockConfigUtils,
      authUtils: mockAuthUtils,
      fetchSettings: mockFetchSettings
    });
  }

  it('displays project settings', async () => {
    await runSettings();

    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('FitFlow')
    );
    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('casual')
    );
    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('English (en)')
    );
    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('Swedish (sv)')
    );
  });

  it('outputs JSON when --output json is specified', async () => {
    await runSettings({ output: 'json' });

    const output = mockConsole.log.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(parsed.settings.name).toBe('FitFlow');
    expect(parsed.settings.source_language.code).toBe('en');
    expect(parsed.settings.target_languages).toHaveLength(2);
  });

  it('omits null settings in display mode', async () => {
    mockFetchSettings.mockResolvedValue({
      settings: {
        ...sampleSettings.settings,
        brand_name: null,
        style_guide: null
      }
    });

    await runSettings();

    const allOutput = mockConsole.log.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).not.toContain('Brand:');
    expect(allOutput).not.toContain('Style:');
  });
});
