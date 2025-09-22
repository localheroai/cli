import { jest } from '@jest/globals';
import { init } from '../../src/commands/init.js';

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
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
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
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
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
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
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
      .mockResolvedValueOnce('test-project')
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('fr,es')
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

  it('configures Django workflow for Django projects', async () => {
    configUtils.getProjectConfig.mockResolvedValue(null);
    authUtils.checkAuth.mockResolvedValue(true);
    projectApi.listProjects.mockResolvedValue([]);
    promptService.selectProject.mockResolvedValue({ choice: 'new' });
    promptService.input
      .mockResolvedValueOnce('django-project')
      .mockResolvedValueOnce('sv')
      .mockResolvedValueOnce('en,da,no')
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