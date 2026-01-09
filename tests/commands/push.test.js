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
      files: { source: [1], target: [1, 2] }
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

  it('handles no_changes status', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'no_changes',
      files: { source: [], target: [] }
    });

    await push(mockConfig, {}, createPushDeps());

    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('No translation changes detected'));
    expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('--force'));
  });

  it('passes force flag to import service', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: { updated_translations: 1, created_translations: 0 }
    });

    await push(mockConfig, { force: true }, createPushDeps());

    expect(mockImportService.pushTranslations).toHaveBeenCalledWith(
      mockConfig,
      process.cwd(),
      expect.objectContaining({ force: true })
    );
  });

  it('passes verbose flag to import service', async () => {
    mockPrompt.confirm.mockResolvedValue(true);
    mockImportService.pushTranslations.mockResolvedValue({
      status: 'completed',
      statistics: { updated_translations: 1, created_translations: 0 }
    });

    await push(mockConfig, { verbose: true }, createPushDeps());

    expect(mockImportService.pushTranslations).toHaveBeenCalledWith(
      mockConfig,
      process.cwd(),
      expect.objectContaining({ verbose: true })
    );
  });

  describe('--prune flag', () => {
    const mockPrunableKeys = [
      { id: 'key1', name: 'old.key.one', context: null, path: 'en.json' },
      { id: 'key2', name: 'old.key.two', context: 'menu', path: 'en.json' }
    ];

    it('shows warning when using --prune without --force', async () => {
      mockPrompt.confirm.mockResolvedValue(false);

      await push(mockConfig, { prune: true }, createPushDeps());

      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('--prune without --force'));
      expect(mockPrompt.confirm).toHaveBeenCalledWith({
        message: 'Continue with filtered prune?',
        default: false
      });
    });

    it('skips filtered prune warning with --force', async () => {
      mockPrompt.confirm.mockResolvedValue(true);
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: []
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps());

      expect(mockConsole.log).not.toHaveBeenCalledWith(expect.stringContaining('--prune without --force'));
    });

    it('passes prune flag to import service', async () => {
      mockPrompt.confirm.mockResolvedValue(true);
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: []
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps());

      expect(mockImportService.pushTranslations).toHaveBeenCalledWith(
        mockConfig,
        process.cwd(),
        expect.objectContaining({ prune: true })
      );
    });

    it('shows message when no keys to prune', async () => {
      mockPrompt.confirm.mockResolvedValue(true);
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: []
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps());

      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('No stale keys to prune'));
    });

    it('shows prunable keys and asks for confirmation', async () => {
      mockPrompt.confirm
        .mockResolvedValueOnce(true)  // Initial push confirmation
        .mockResolvedValueOnce(false); // Prune confirmation (decline)
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: mockPrunableKeys
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps());

      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('2 keys found for pruning'));
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('old.key.one'));
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('old.key.two'));
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('(context: menu)'));
      expect(mockPrompt.confirm).toHaveBeenCalledWith({
        message: 'Prune these keys? This cannot be undone.',
        default: false
      });
    });

    it('calls bulk delete when prune is confirmed', async () => {
      const mockBulkDeleteKeys = jest.fn().mockResolvedValue({ deleted_count: 2 });
      mockPrompt.confirm
        .mockResolvedValueOnce(true)  // Initial push confirmation
        .mockResolvedValueOnce(true); // Prune confirmation
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: mockPrunableKeys
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps({
        bulkDeleteKeys: mockBulkDeleteKeys
      }));

      expect(mockBulkDeleteKeys).toHaveBeenCalledWith({
        projectId: 'test-project',
        keyIds: ['key1', 'key2']
      });
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Pruned 2 keys'));
    });

    it('skips prune confirmation with --yes flag', async () => {
      const mockBulkDeleteKeys = jest.fn().mockResolvedValue({ deleted_count: 2 });
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: mockPrunableKeys
      });

      await push(mockConfig, { prune: true, force: true, yes: true }, createPushDeps({
        bulkDeleteKeys: mockBulkDeleteKeys
      }));

      // Should only have one confirmation call (none, since yes skips all)
      expect(mockPrompt.confirm).not.toHaveBeenCalled();
      expect(mockBulkDeleteKeys).toHaveBeenCalled();
    });

    it('does not call bulk delete when prune is cancelled', async () => {
      const mockBulkDeleteKeys = jest.fn();
      mockPrompt.confirm
        .mockResolvedValueOnce(true)  // Initial push confirmation
        .mockResolvedValueOnce(false); // Prune confirmation (decline)
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: mockPrunableKeys
      });

      await push(mockConfig, { prune: true, force: true }, createPushDeps({
        bulkDeleteKeys: mockBulkDeleteKeys
      }));

      expect(mockBulkDeleteKeys).not.toHaveBeenCalled();
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('Prune cancelled'));
    });

    it('propagates errors from bulk delete', async () => {
      const mockBulkDeleteKeys = jest.fn().mockRejectedValue(new Error('API error'));
      mockPrompt.confirm
        .mockResolvedValueOnce(true)  // Initial push confirmation
        .mockResolvedValueOnce(true); // Prune confirmation
      mockImportService.pushTranslations.mockResolvedValue({
        status: 'completed',
        statistics: { updated_translations: 1, created_translations: 0 },
        prunable_keys: mockPrunableKeys
      });

      await expect(push(mockConfig, { prune: true, force: true }, createPushDeps({
        bulkDeleteKeys: mockBulkDeleteKeys
      }))).rejects.toThrow('API error');
    });
  });
});