import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { glossary, GlossaryOptions } from '../../src/commands/glossary.js';

describe('glossary command', () => {
  let mockConsole: { log: jest.Mock; error: jest.Mock };
  let mockConfigUtils: any;
  let mockAuthUtils: { checkAuth: jest.Mock };
  let mockFetchGlossaryTerms: jest.Mock;

  const sampleTerms = [
    {
      term: 'Workspace',
      context: 'The main container for user content',
      translation_strategy: 'Always translate',
      case_sensitive: false,
      example_translations: { sv: 'Arbetsyta', de: 'Arbeitsbereich' }
    },
    {
      term: 'API Key',
      context: null,
      translation_strategy: 'Never translate',
      case_sensitive: true,
      example_translations: {}
    },
    {
      term: 'Dashboard',
      context: 'The main overview page',
      translation_strategy: 'Adapt to market',
      case_sensitive: false,
      example_translations: {}
    }
  ];

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

    mockFetchGlossaryTerms = jest.fn().mockResolvedValue({
      glossary_terms: sampleTerms
    });
  });

  function runGlossary(options: GlossaryOptions = {}) {
    return glossary(options, {
      console: mockConsole,
      configUtils: mockConfigUtils,
      authUtils: mockAuthUtils,
      fetchGlossaryTerms: mockFetchGlossaryTerms
    });
  }

  it('displays glossary terms in table format', async () => {
    await runGlossary();

    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('Project glossary (3 terms)')
    );
    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('Workspace')
    );
    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('API Key')
    );
  });

  it('outputs JSON when --output json is specified', async () => {
    await runGlossary({ output: 'json' });

    const output = mockConsole.log.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(parsed.glossary_terms).toHaveLength(3);
    expect(parsed.glossary_terms[0].term).toBe('Workspace');
  });

  it('passes search param to API', async () => {
    await runGlossary({ search: 'work' });

    expect(mockFetchGlossaryTerms).toHaveBeenCalledWith('test-project', 'work');
  });

  it('shows message when no terms found', async () => {
    mockFetchGlossaryTerms.mockResolvedValue({ glossary_terms: [] });

    await runGlossary();

    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('No glossary terms configured')
    );
  });

  it('shows search-specific message when search has no results', async () => {
    mockFetchGlossaryTerms.mockResolvedValue({ glossary_terms: [] });

    await runGlossary({ search: 'nonexistent' });

    expect(mockConsole.log).toHaveBeenCalledWith(
      expect.stringContaining('No glossary terms matching "nonexistent"')
    );
  });

});
