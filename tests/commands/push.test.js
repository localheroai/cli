import { jest } from '@jest/globals';
import { push } from '../../src/commands/push.js';

describe('push command', () => {
  let mockConsole;
  let mockImportService;
  let mockPrompt;

  function createPushDeps(overrides = {}) {
    return {
      console: mockConsole,
      importService: mockImportService,
      prompt: mockPrompt,
      ...overrides
    };
  }

  const mockConfig = {
    projectId: 'test-project',
    sourceLocale: 'en'
  };

  beforeEach(() => {
    mockConsole = { log: jest.fn() };
    mockImportService = {
      pushTranslations: jest.fn()
    };
    mockPrompt = {
      confirm: jest.fn()
    };
    jest.clearAllMocks();
  });

  it('prompts for confirmation before pushing', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: { updated: 1, added: 0, ignored: 0 }
    });

    await push(mockConfig, {}, createPushDeps());

    expect(mockPrompt.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining('push your local translations'),
      default: true
    });
  });

  it('cancels operation when confirmation is rejected', async () => {
    mockPrompt.confirm.mockResolvedValue(false);

    await push(mockConfig, {}, createPushDeps());

    expect(mockImportService.pushTranslations).not.toHaveBeenCalled();
    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('skips confirmation with yes flag', async () => {
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: { updated: 1, added: 0, ignored: 0 }
    });

    await push(mockConfig, { yes: true }, createPushDeps());

    expect(mockPrompt.confirm).not.toHaveBeenCalled();
    expect(mockImportService.pushTranslations).toHaveBeenCalled();
  });

  it('displays success messages with statistics', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: {
        updated_translations: 2,
        created_translations: 1,
      }
    });

    await push(mockConfig, {}, createPushDeps());

    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Updated 2 translations'));
    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Added 1 new translations'));
  });

  it('shows verbose output when flag is set', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: { updated_translations: 1, created_translations: 0 },
      files: { target: [1, 2, 3] }
    });

    await push(mockConfig, { verbose: true }, createPushDeps());

    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Found 3 translation files'));
  });

  it('handles case when no files are found', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'no_files'
    });

    await push(mockConfig, {}, createPushDeps());

    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('No translation files found'));
  });

  it('throws error on failed push', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'failed',
      error: 'API error'
    });

    await expect(push(mockConfig, {}, createPushDeps()))
      .rejects
      .toThrow('API error');
  });
});