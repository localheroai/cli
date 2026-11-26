import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  processDocumentBatches,
  DOCUMENT_BATCH_CONCURRENCY,
  JOB_STALL_MINUTES
} from '../../src/utils/translation-processor.js';
import { buildDocumentBatches, findMissingDocuments } from '../../src/utils/documents.js';
import { DocumentWriteError } from '../../src/utils/translation-updater/document-handler.js';
import { ApiResponseError } from '../../src/types/index.js';
import type { ProjectConfig, TranslationFile } from '../../src/types/index.js';

const config = { projectId: 'project-1', sourceLocale: 'en', outputLocales: ['sv', 'de'] } as ProjectConfig;

function article(slug: string): TranslationFile {
  return {
    path: `articles/en/${slug}.md`,
    format: 'md',
    locale: 'en',
    documentFormat: 'markdown',
    content: Buffer.from(`# ${slug}\n\nBody of ${slug}.\n`).toString('base64')
  };
}

function prepare(slugs: string[], outputLocales = config.outputLocales) {
  const missing = findMissingDocuments(slugs.map(article), {}, { sourceLocale: 'en', outputLocales });
  return { missing, batches: buildDocumentBatches(missing).batches };
}

function slugOf(request: any): string {
  return request.sourceFiles[0].path.split('/').pop().replace('.md', '');
}

function completed(code: string, name: string, value: unknown) {
  return { status: 'completed', language: { code }, translations: { data: { [name]: value } } };
}

function networkError(): Error {
  return Object.assign(new TypeError('fetch failed'), { cliErrorMessage: 'Network error while connecting' });
}

describe('processDocumentBatches', () => {
  let translationUtils: any;
  let deps: any;
  let jobs: Map<string, { slug: string; code: string }>;

  const run = (prepared: ReturnType<typeof prepare>) =>
    processDocumentBatches(prepared.batches, prepared.missing as any, config, false, deps, 'group-1');

  const statuses = (result: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(result.outcomes.map(outcome => [`${outcome.path.split('/').pop()}:${outcome.locale}`, outcome.status]));

  beforeEach(() => {
    jobs = new Map();
    translationUtils = {
      createTranslationJob: jest.fn(async (request: any) => ({
        jobs: request.targetLocales.map((code: string) => {
          const id = `job-${slugOf(request)}-${code}`;
          jobs.set(id, { slug: slugOf(request), code });
          return { id, language: { code } };
        }),
        job_group: { id: 'group-1', short_url: 'https://localhero.ai/r/abc' }
      })),
      checkJobStatus: jest.fn(async (jobId: string) => {
        const { slug, code } = jobs.get(jobId)!;
        return completed(code, `${slug}.md`, `# ${slug} (${code})\n`);
      }),
      updateTranslationFile: jest.fn(async (_path: string, translations: Record<string, unknown>) => ({
        updatedKeys: Object.keys(translations),
        created: true
      }))
    };
    deps = { console: { log: jest.fn(), error: jest.fn(), warn: jest.fn() }, translationUtils };
  });

  it('creates one job request per article and writes each locale whole', async () => {
    const result = await run(prepare(['export-reports']));

    expect(translationUtils.createTranslationJob).toHaveBeenCalledTimes(1);
    const request = translationUtils.createTranslationJob.mock.calls[0][0];
    expect(request).toMatchObject({
      projectId: 'project-1',
      targetLocales: ['sv', 'de'],
      targetPaths: { sv: 'articles/sv/export-reports.md', de: 'articles/de/export-reports.md' },
      jobGroupId: 'group-1'
    });
    expect(request.sourceFiles).toHaveLength(1);
    expect(request.sourceFiles[0]).toMatchObject({ path: 'articles/en/export-reports.md', format: 'markdown' });

    expect(translationUtils.updateTranslationFile).toHaveBeenCalledWith(
      'articles/sv/export-reports.md',
      { 'export-reports.md': '# export-reports (sv)\n' },
      'sv',
      'articles/en/export-reports.md',
      undefined,
      config
    );
    expect(statuses(result)).toEqual({ 'export-reports.md:sv': 'written', 'export-reports.md:de': 'written' });
    expect(result.stopped).toBeNull();
    expect(result.jobGroupShortUrl).toBe('https://localhero.ai/r/abc');
  });

  it(`runs at most ${DOCUMENT_BATCH_CONCURRENCY} articles at a time`, async () => {
    let active = 0;
    let peak = 0;
    const create = translationUtils.createTranslationJob.getMockImplementation();
    translationUtils.createTranslationJob.mockImplementation(async (request: any) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      return create(request);
    });
    translationUtils.updateTranslationFile.mockImplementation(async (_path: string, translations: Record<string, unknown>) => {
      active--;
      return { updatedKeys: Object.keys(translations), created: true };
    });

    const result = await run(prepare(Array.from({ length: 10 }, (_, i) => `article-${i}`), ['sv']));

    expect(peak).toBe(DOCUMENT_BATCH_CONCURRENCY);
    expect(result.outcomes.filter(outcome => outcome.status === 'written')).toHaveLength(10);
  });

  it('goes on with the next article when one fails', async () => {
    translationUtils.checkJobStatus.mockImplementation(async (jobId: string) => {
      const { slug, code } = jobs.get(jobId)!;
      return slug === 'broken'
        ? { status: 'failed', language: { code }, error_details: 'model refused' }
        : completed(code, `${slug}.md`, `# ${slug}\n`);
    });

    const result = await run(prepare(['broken', 'export-reports'], ['sv']));

    expect(statuses(result)).toEqual({ 'broken.md:sv': 'failed', 'export-reports.md:sv': 'written' });
    expect(result.outcomes.find(outcome => outcome.status === 'failed')?.reason).toContain('model refused');
    expect(result.stopped).toBeNull();
  });

  it('waits for a sibling locale to be written before an article with a failed locale is done', async () => {
    const events: string[] = [];
    let finishWrite: () => void = () => undefined;
    translationUtils.checkJobStatus.mockImplementation(async (jobId: string) => {
      const { slug, code } = jobs.get(jobId)!;
      return code === 'sv'
        ? { status: 'failed', language: { code }, error_details: 'sv broke' }
        : completed(code, `${slug}.md`, '# Bericht\n');
    });
    translationUtils.updateTranslationFile.mockImplementation(async () => {
      events.push('de write started');
      await new Promise<void>(resolve => { finishWrite = resolve; });
      events.push('de write finished');
      return { updatedKeys: ['export-reports.md'], created: true };
    });

    const running = run(prepare(['export-reports'])).then(result => {
      events.push('returned');
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['de write started']);

    finishWrite();
    const result = await running;

    expect(events).toEqual(['de write started', 'de write finished', 'returned']);
    expect(statuses(result)).toEqual({ 'export-reports.md:sv': 'failed', 'export-reports.md:de': 'written' });
  });

  it('reports a language the server skipped and polls nothing for it', async () => {
    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [{ id: 'job-de', language: { code: 'de' } }],
      skipped_documents: [{ path: 'articles/en/export-reports.md', language: 'sv', reason: 'new_language_waits_for_updates' }]
    });
    translationUtils.checkJobStatus.mockResolvedValue(completed('de', 'export-reports.md', '# Bericht\n'));

    const result = await run(prepare(['export-reports']));

    expect(translationUtils.checkJobStatus).toHaveBeenCalledTimes(1);
    expect(result.outcomes).toEqual([
      {
        path: 'articles/en/export-reports.md',
        locale: 'sv',
        targetPath: 'articles/sv/export-reports.md',
        status: 'skipped',
        reason: 'new_language_waits_for_updates'
      },
      { path: 'articles/en/export-reports.md', locale: 'de', targetPath: 'articles/de/export-reports.md', status: 'written' }
    ]);
  });

  it('matches a skipped language spelled another way than the configuration', async () => {
    translationUtils.createTranslationJob.mockResolvedValue({
      jobs: [],
      skipped_documents: [{ path: 'articles/en/export-reports.md', language: 'pt-br', reason: 'new_language_waits_for_updates' }]
    });

    const result = await run(prepare(['export-reports'], ['pt_BR']));

    expect(statuses(result)).toEqual({ 'export-reports.md:pt_BR': 'skipped' });
  });

  it('counts a language with auto-translation off as skipped', async () => {
    translationUtils.checkJobStatus.mockImplementation(async (jobId: string) => ({
      status: 'completed',
      language: { code: jobs.get(jobId)!.code },
      auto_translate_disabled: true,
      translations: { data: { 'export-reports.md': null } }
    }));

    const result = await run(prepare(['export-reports'], ['sv']));

    expect(statuses(result)).toEqual({ 'export-reports.md:sv': 'skipped' });
    expect(translationUtils.updateTranslationFile).not.toHaveBeenCalled();
  });

  it('counts a completed job without a text as failed', async () => {
    translationUtils.checkJobStatus.mockImplementation(async (jobId: string) =>
      completed(jobs.get(jobId)!.code, 'export-reports.md', null));

    const result = await run(prepare(['export-reports'], ['sv']));

    expect(statuses(result)).toEqual({ 'export-reports.md:sv': 'failed' });
    expect(translationUtils.updateTranslationFile).not.toHaveBeenCalled();
  });

  it('counts a value the writer refuses as failed', async () => {
    translationUtils.checkJobStatus.mockImplementation(async (jobId: string) =>
      completed(jobs.get(jobId)!.code, 'export-reports.md', { title: 'Rubrik' }));
    translationUtils.updateTranslationFile.mockRejectedValue(
      new DocumentWriteError('articles/sv/export-reports.md', 'the value is not a text')
    );

    const result = await run(prepare(['export-reports', 'second'], ['sv']));

    expect(statuses(result)['export-reports.md:sv']).toBe('failed');
    expect(result.stopped).toBeNull();
  });

  it.each(['document_file', 'job_group_required', 'insufficient_credits'])(
    'stops sending articles on %s',
    async (code) => {
      translationUtils.createTranslationJob.mockRejectedValue(
        new ApiResponseError('Not possible for this project', { code })
      );

      const result = await run(prepare(Array.from({ length: 7 }, (_, i) => `article-${i}`), ['sv']));

      expect(translationUtils.createTranslationJob).toHaveBeenCalledTimes(DOCUMENT_BATCH_CONCURRENCY);
      expect(result.stopped).toEqual({ code, message: 'Not possible for this project' });
      expect(result.outcomes).toHaveLength(7);
      expect(result.outcomes.every(outcome => outcome.status === 'not_sent')).toBe(true);
    }
  );

  it('stops sending articles when the server cannot be reached', async () => {
    translationUtils.createTranslationJob.mockRejectedValue(networkError());

    const result = await run(prepare(['one', 'two', 'three', 'four', 'five', 'six'], ['sv']));

    expect(translationUtils.createTranslationJob).toHaveBeenCalledTimes(DOCUMENT_BATCH_CONCURRENCY);
    expect(result.stopped).toEqual({ code: 'network_error', message: 'Network error while connecting' });
  });

  it.each(['invalid_document', 'document_too_large'])('reports an article refused with %s and goes on', async (code) => {
    const create = translationUtils.createTranslationJob.getMockImplementation();
    translationUtils.createTranslationJob.mockImplementation(async (request: any) => {
      if (slugOf(request) === 'refused') throw new ApiResponseError('The article was refused', { code });
      return create(request);
    });

    const result = await run(prepare(['refused', 'export-reports'], ['sv']));

    expect(statuses(result)).toEqual({ 'refused.md:sv': 'refused', 'export-reports.md:sv': 'written' });
    expect(result.outcomes[0].reason).toBe('The article was refused');
    expect(result.stopped).toBeNull();
  });

  it('counts any other refusal as failed and goes on', async () => {
    const create = translationUtils.createTranslationJob.getMockImplementation();
    translationUtils.createTranslationJob.mockImplementation(async (request: any) => {
      if (slugOf(request) === 'busy') throw new ApiResponseError('Source file is busy', { code: 'source_file_busy' });
      return create(request);
    });

    const result = await run(prepare(['busy', 'export-reports'], ['sv']));

    expect(statuses(result)).toEqual({ 'busy.md:sv': 'failed', 'export-reports.md:sv': 'written' });
  });

  it('gives up on a job that makes no progress and counts it as failed', async () => {
    jest.useFakeTimers({ now: 0 });
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = jest.fn((callback: () => void, ms = 0) => {
      jest.setSystemTime(Date.now() + ms);
      callback();
      return 1;
    }) as any;
    translationUtils.checkJobStatus.mockResolvedValue({ status: 'processing', language: { code: 'sv' } });

    try {
      const result = await run(prepare(['export-reports'], ['sv']));

      expect(statuses(result)).toEqual({ 'export-reports.md:sv': 'failed' });
      expect(result.outcomes[0].reason).toContain(`no progress for ${JOB_STALL_MINUTES} minutes`);
    } finally {
      global.setTimeout = originalSetTimeout;
      jest.useRealTimers();
    }
  });
});
