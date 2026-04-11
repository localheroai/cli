import { jest } from '@jest/globals';
import { init, buildFilePatternFromContents } from '../../src/commands/init.js';

describe('init command', () => {
  let mockConsole;
  let configUtils;
  let authUtils;
  let promptService;
  let projectApi;
  let importUtils;
  let login;

  function createInitDeps(overrides = {}) {
    return {
      console: mockConsole,
      configUtils,
      authUtils,
      promptService,
      projectApi,
      importUtils,
      login,
      ...overrides
    };
  }

  beforeEach(() => {
    mockConsole = { log: jest.fn(), warn: console.warn };
    configUtils = {
      getProjectConfig: jest.fn(),
      saveProjectConfig: jest.fn().mockResolvedValue(true),
      getAuthConfig: jest.fn().mockResolvedValue(null),
      saveAuthConfig: jest.fn().mockResolvedValue(true),
      updateLastSyncedAt: jest.fn().mockResolvedValue(undefined)
    };
    authUtils = {
      checkAuth: jest.fn(),
      verifyApiKey: jest.fn().mockResolvedValue({
        error: null,
        organization: {
          name: 'Test Org',
          projects: []
        }
      })
    };
    promptService = {
      select: jest.fn(),
      input: jest.fn(),
      confirm: jest.fn(),
      getProjectSetup: jest.fn(),
      getApiKey: jest.fn(),
      selectProject: jest.fn()
    };
    projectApi = {
      listProjects: jest.fn(),
      createProject: jest.fn()
    };
    importUtils = {
      importTranslations: jest.fn().mockResolvedValue({ status: 'no_files' })
    };
    login = jest.fn().mockResolvedValue(true);
    jest.resetAllMocks();
  });

  it('handles existing configuration and checks authentication', async () => {
    const validConfig = {
      projectId: 'test-123',
      sourceLocale: 'en',
      outputLocales: ['es', 'fr'],
      translationFiles: { pattern: '**/*.json' }
    };
    configUtils.getProjectConfig.mockResolvedValue(validConfig);
    authUtils.checkAuth.mockResolvedValue(true); // Already authenticated
    promptService.confirm.mockResolvedValue(false); // Don't import

    await init(createInitDeps());

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('Configuration found!');
    expect(allConsoleOutput).toContain('API key found and valid');
    expect(login).not.toHaveBeenCalled();
  });

  it('validates existing configuration and shows error for invalid config', async () => {
    const invalidConfig = { exists: true }; // Missing required fields
    configUtils.getProjectConfig.mockResolvedValue(invalidConfig);

    await init(createInitDeps());

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('Configuration found!');
    expect(allConsoleOutput).toContain('Invalid configuration: missing fields');
    expect(authUtils.checkAuth).not.toHaveBeenCalled();
  });

  it('detects when authentication is needed', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(false);

    const mockLogin = jest.fn().mockImplementation(async () => {
      throw new Error('User cancelled');
    });

    await expect(init(createInitDeps({ login: mockLogin }))).rejects.toThrow('User cancelled');

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('No API key found');
    expect(mockLogin).toHaveBeenCalled();
  });

  it('initializes project configuration successfully', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    projectApi.createProject.mockResolvedValue({
      id: 'proj_123',
      name: 'test-project',
      url: 'https://localhero.ai/organizations/123'
    });
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await init(createInitDeps());

    expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj_123',
        sourceLocale: 'en',
        outputLocales: ['fr', 'es'],
        translationFiles: expect.objectContaining({
          pattern: expect.any(String)
        })
      }),
      expect.any(String)
    );

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('✓ Created localhero.json');
    expect(allConsoleOutput).toContain('https://localhero.ai/organizations/123');
  });

  it('handles project creation failure gracefully', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    projectApi.createProject.mockRejectedValue(new Error('API failure'));

    await init(createInitDeps());

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('✗ Failed to create project: API failure');
    expect(configUtils.saveProjectConfig).not.toHaveBeenCalled();
  });

  it('successfully selects existing project from list', async () => {
    const testProject = {
      id: 'proj_123',
      name: 'Existing Project',
      source_language: 'en',
      target_languages: ['fr', 'es']
    };
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([testProject]);
    promptService.selectProject.mockResolvedValue({ choice: testProject.id, project: testProject });
    promptService.input
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await init(createInitDeps());

    expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: testProject.id,
        sourceLocale: testProject.source_language,
        outputLocales: testProject.target_languages,
        translationFiles: expect.objectContaining({
          pattern: expect.any(String)
        })
      }),
      expect.any(String)
    );
  });

  it('handles translation import failures', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    projectApi.createProject.mockResolvedValue({
      id: 'proj_123',
      name: 'test-project'
    });
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    importUtils.importTranslations.mockResolvedValue({
      status: 'error',
      error: 'Import failed'
    });

    await init(createInitDeps());

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('✗ Failed to import translations');
    expect(allConsoleOutput).toContain('Error: Import failed');
  });

  it('displays translations URL when available', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    projectApi.createProject.mockResolvedValue({
      id: 'proj_123',
      name: 'test-project'
    });
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    importUtils.importTranslations.mockResolvedValue({
      status: 'success',
      statistics: {
        added: 8,
        updated: 2,
        ignored: 0
      },
      translations_url: 'https://localhero.ai/projects/proj_123/translations',
      files: {
        source: [{ path: 'locales/en.json', language: 'en', format: 'json', namespace: '' }],
        target: [{ path: 'locales/fr.json', language: 'fr', format: 'json', namespace: '' }]
      }
    });

    await init(createInitDeps());

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('✓ Successfully imported translations');
    expect(allConsoleOutput).toContain('View your translations at: https://localhero.ai/projects/proj_123/translations');
  });

  it('filters source language from target languages with warning', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,en,es')
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('locales/')
      .mockResolvedValueOnce('');
    projectApi.createProject.mockResolvedValue({
      id: 'proj_123',
      name: 'test-project'
    });
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await init(createInitDeps());

    expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLocale: 'en',
        outputLocales: ['fr', 'es']
      }),
      expect.any(String)
    );

    const allConsoleOutput = mockConsole.log.mock.calls.map(call => call[0]).join('\n');
    expect(allConsoleOutput).toContain('⚠️  Source language \'en\' removed from target languages');
  });

  describe('non-interactive mode', () => {
    const baseFlags = {
      yes: true,
      sourceLocale: 'en',
      targetLocales: 'fr,es',
      path: 'locales/'
    };

    it('creates a new project using flag values without any prompts', async () => {
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(true);
      projectApi.listProjects.mockResolvedValue([]);
      projectApi.createProject.mockResolvedValue({
        id: 'proj_new',
        name: 'noodling',
        url: 'https://localhero.ai/projects/proj_new'
      });

      await init(createInitDeps({ options: { ...baseFlags, projectName: 'noodling' } }));

      expect(promptService.selectProject).not.toHaveBeenCalled();
      expect(promptService.input).not.toHaveBeenCalled();
      expect(promptService.confirm).not.toHaveBeenCalled();
      expect(projectApi.createProject).toHaveBeenCalledWith({
        name: 'noodling',
        sourceLocale: 'en',
        targetLocales: ['fr', 'es']
      });
      expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj_new',
          sourceLocale: 'en',
          outputLocales: ['fr', 'es'],
          translationFiles: expect.objectContaining({
            paths: ['locales/'],
            pattern: expect.any(String)
          })
        }),
        expect.any(String)
      );
    });

    it('uses an existing project when --project-id is passed', async () => {
      const existing = {
        id: 'proj_existing',
        name: 'Existing',
        source_language: 'en',
        target_languages: ['sv', 'de'],
        url: 'https://localhero.ai/projects/proj_existing'
      };
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(true);
      projectApi.listProjects.mockResolvedValue([existing]);

      await init(createInitDeps({
        options: { yes: true, projectId: 'proj_existing', path: 'locales/' }
      }));

      expect(projectApi.createProject).not.toHaveBeenCalled();
      expect(configUtils.saveProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj_existing',
          sourceLocale: 'en',
          outputLocales: ['sv', 'de']
        }),
        expect.any(String)
      );
    });

    it('throws a clear error when required flags are missing', async () => {
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(true);

      await expect(init(createInitDeps({
        options: { yes: true, sourceLocale: 'en' }
      }))).rejects.toThrow(/Missing required flags.*--target-locales.*--path/s);

      expect(configUtils.saveProjectConfig).not.toHaveBeenCalled();
      expect(projectApi.createProject).not.toHaveBeenCalled();
    });

    it('throws when --project-id is not found in the organization', async () => {
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(true);
      projectApi.listProjects.mockResolvedValue([{ id: 'other', name: 'other' }]);

      await expect(init(createInitDeps({
        options: { yes: true, projectId: 'missing', path: 'locales/' }
      }))).rejects.toThrow(/Project missing not found/);

      expect(configUtils.saveProjectConfig).not.toHaveBeenCalled();
    });

    it('authenticates via --api-key when no existing auth config is present', async () => {
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(false);
      projectApi.listProjects.mockResolvedValue([]);
      projectApi.createProject.mockResolvedValue({
        id: 'proj_new',
        name: 'x',
        url: null
      });
      const loginFn = jest.fn().mockResolvedValue(true);

      await init(createInitDeps({
        login: loginFn,
        options: { ...baseFlags, apiKey: 'tk_test_key_123' }
      }));

      expect(loginFn).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'tk_test_key_123', isCalledFromInit: true })
      );
    });

    it('fails with an actionable error when no auth is available', async () => {
      const previousEnvKey = process.env.LOCALHERO_API_KEY;
      delete process.env.LOCALHERO_API_KEY;
      try {
        configUtils.getProjectConfig.mockResolvedValue(null);
        authUtils.checkAuth.mockResolvedValue(false);

        await expect(init(createInitDeps({
          options: baseFlags
        }))).rejects.toThrow(/API key required.*--api-key.*LOCALHERO_API_KEY/s);
      } finally {
        if (previousEnvKey !== undefined) {
          process.env.LOCALHERO_API_KEY = previousEnvKey;
        }
      }
    });

    it('verifies existing localhero.json and runs import when not yet synced', async () => {
      const existingConfig = {
        projectId: 'proj_123',
        sourceLocale: 'en',
        outputLocales: ['fr'],
        translationFiles: { paths: ['locales/'], pattern: '**/*.json' },
        lastSyncedAt: null
      };
      configUtils.getProjectConfig.mockResolvedValue(existingConfig);
      authUtils.checkAuth.mockResolvedValue(true);
      projectApi.listProjects.mockResolvedValue([{ id: 'proj_123', name: 'X' }]);
      importUtils.importTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { total_keys: 0, languages: [] },
        files: { source: [], target: [] }
      });

      await init(createInitDeps({ options: { yes: true } }));

      expect(importUtils.importTranslations).toHaveBeenCalled();
      expect(promptService.confirm).not.toHaveBeenCalled();
    });

    it('creates a GitHub Action workflow when --github-action is passed', async () => {
      const githubUtils = {
        createGitHubActionFile: jest.fn().mockResolvedValue('.github/workflows/localhero.yml'),
        workflowExists: jest.fn().mockReturnValue(false)
      };
      configUtils.getProjectConfig.mockResolvedValue(null);
      authUtils.checkAuth.mockResolvedValue(true);
      projectApi.listProjects.mockResolvedValue([]);
      projectApi.createProject.mockResolvedValue({
        id: 'proj_new',
        name: 'x',
        url: null
      });

      await init(createInitDeps({
        githubUtils,
        options: { ...baseFlags, githubAction: true }
      }));

      expect(githubUtils.createGitHubActionFile).toHaveBeenCalled();
      expect(promptService.confirm).not.toHaveBeenCalled();
    });

  });

  it('configures Django workflow for Django projects', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('sv')
      .mockResolvedValueOnce('en,da,no')
      .mockResolvedValueOnce('django-project')
      .mockResolvedValueOnce('translations/')
      .mockResolvedValueOnce('**/sources/**');
    projectApi.createProject.mockResolvedValue({
      id: 'proj_django',
      name: 'django-project'
    });
    promptService.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const fs = await import('fs');
    const originalStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockImplementation((path) => {
      if (path === 'manage.py') {
        return Promise.resolve({ isFile: () => true });
      }
      return originalStat(path);
    });

    await init(createInitDeps());

    const saveConfigCall = configUtils.saveProjectConfig.mock.calls[0];
    const savedConfig = saveConfigCall[0];

    expect(savedConfig.translationFiles.workflow).toBe('django');
    expect(savedConfig.translationFiles.ignore).toContain('**/sources/**');
    expect(savedConfig.translationFiles.pattern).toBe('**/*.po');

    // Restore original stat function
    fs.promises.stat = originalStat;
  });
});

describe('buildFilePatternFromContents', () => {
  const emptyContents = () => ({ files: [], jsonFiles: [], yamlFiles: [], poFiles: [] });

  it('returns the generic fallback pattern when no files are detected', () => {
    const contents = emptyContents();
    expect(buildFilePatternFromContents(contents)).toBe('**/*.{json,yml,yaml,po}');
  });

  it('returns a plain json pattern when only json files are present', () => {
    const contents = { ...emptyContents(), jsonFiles: ['en.json', 'fr.json'] };
    expect(buildFilePatternFromContents(contents)).toBe('**/*.json');
  });

  it('returns a plain po pattern when only po files are present', () => {
    const contents = { ...emptyContents(), poFiles: ['en.po'] };
    expect(buildFilePatternFromContents(contents)).toBe('**/*.po');
  });

  it('returns the yml/yaml brace pattern when only yaml files are present', () => {
    const contents = { ...emptyContents(), yamlFiles: ['en.yml'] };
    expect(buildFilePatternFromContents(contents)).toBe('**/*.{yml,yaml}');
  });

  it('combines formats when multiple extensions are present', () => {
    const contents = {
      ...emptyContents(),
      jsonFiles: ['en.json'],
      yamlFiles: ['fr.yml']
    };
    expect(buildFilePatternFromContents(contents)).toBe('**/*.{json,yml,yaml}');
  });
});