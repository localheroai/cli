import path from 'path';
import type { DocumentFormat, TranslationFile, TranslationFilesResult } from '../types/index.js';
import type { MissingLocaleEntry } from './translation-utils.js';
import type { TranslationBatch } from './translation-processor.js';

export const MAX_DOCUMENT_CHARACTERS = 20000;
export const WIRE_FORMAT_MARKDOWN = 'markdown';

const DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  html: 'html',
  htm: 'html'
};

const PATH_SEPARATORS = /[\\/]/;

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

export function documentFormatFor(filePath: string): DocumentFormat | null {
  return DOCUMENT_FORMATS[extensionOf(filePath)] ?? null;
}

export function isDocumentPath(filePath: string): boolean {
  return documentFormatFor(filePath) !== null;
}

export function isDocumentExtension(extension: string): boolean {
  return extension.toLowerCase() in DOCUMENT_FORMATS;
}

function localeSegments(filePath: string, knownLocales: string[]): Array<{ index: number; locale: string }> {
  const directories = filePath.split(PATH_SEPARATORS).slice(0, -1);
  return directories.flatMap((segment, index) => {
    const locale = knownLocales.find(known => known && known.toLowerCase() === segment.toLowerCase());
    return locale ? [{ index, locale }] : [];
  });
}

/**
 * The language of a document is the one directory segment that is a configured
 * locale. The file name is the article's slug and never names the language.
 */
export function documentLocale(filePath: string, knownLocales: string[]): string | null {
  const segments = localeSegments(filePath, knownLocales);
  return segments.length === 1 ? segments[0].locale : null;
}

export function documentTargetPath(sourcePath: string, targetLocale: string, knownLocales: string[]): string | null {
  const segments = localeSegments(sourcePath, knownLocales);
  if (segments.length !== 1) return null;

  const parts = sourcePath.split(PATH_SEPARATORS);
  parts[segments[0].index] = targetLocale;
  return parts.join('/');
}

export function documentKeyName(filePath: string): string {
  return path.basename(filePath);
}

export function toLfText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function documentLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Documents are opt-in: a project gets them only when its file pattern names
 * the extension, as a whole word in the pattern's last segment.
 */
export function patternNamesExtension(pattern: string | undefined, extension: string): boolean {
  if (!pattern) return false;

  const lastSegment = pattern.split('/').pop() ?? '';
  const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(lastSegment);
}

export interface DocumentRefusal {
  path: string;
  reason: string;
}

const UNSUPPORTED_REASONS: Record<Exclude<DocumentFormat, 'markdown'>, string> = {
  mdx: 'MDX articles are not supported yet',
  html: 'HTML articles are not supported yet'
};

function isSupported(file: TranslationFile): boolean {
  return !file.documentFormat || file.documentFormat === WIRE_FORMAT_MARKDOWN;
}

/**
 * MDX and HTML are recognised as articles and refused here, so they appear in
 * no request at all: not as a job, a manifest entry or an import.
 */
export function leaveOutUnsupportedDocuments<T extends TranslationFilesResult>(
  discovered: T
): T & { unsupported: DocumentRefusal[] } {
  const unsupported = discovered.sourceFiles.flatMap(file => file.documentFormat && file.documentFormat !== WIRE_FORMAT_MARKDOWN
    ? [{ path: file.path, reason: UNSUPPORTED_REASONS[file.documentFormat] }]
    : []);

  return {
    ...discovered,
    allFiles: discovered.allFiles.filter(isSupported),
    sourceFiles: discovered.sourceFiles.filter(isSupported),
    targetFilesByLocale: Object.fromEntries(
      Object.entries(discovered.targetFilesByLocale).map(([locale, files]) => [locale, files.filter(isSupported)])
    ),
    unsupported
  };
}

function documentText(file: TranslationFile): string {
  return toLfText(Buffer.from(file.content ?? '', 'base64').toString());
}

/**
 * An article is missing in a locale when no file sits at its target path, or
 * the file there is blank. Entries have the shape missing keys use, so the
 * changed-only filter treats an article like a one-key file.
 */
export function findMissingDocuments(
  sourceDocuments: TranslationFile[],
  targetFilesByLocale: Record<string, TranslationFile[]>,
  config: { sourceLocale: string; outputLocales: string[] }
): Record<string, MissingLocaleEntry> {
  const knownLocales = [config.sourceLocale, ...config.outputLocales];
  const missing: Record<string, MissingLocaleEntry> = {};

  for (const source of sourceDocuments) {
    const keys = { [documentKeyName(source.path)]: { value: documentText(source) } };

    for (const locale of config.outputLocales) {
      const targetPath = documentTargetPath(source.path, locale, knownLocales);
      if (!targetPath) continue;

      const target = (targetFilesByLocale[locale] ?? []).find(file => path.normalize(file.path) === path.normalize(targetPath));
      if (target && documentText(target).trim() !== '') continue;

      missing[`${locale}:${source.path}`] = { locale, path: source.path, targetPath, keys, keyCount: 1 };
    }
  }

  return missing;
}

function refusalReason(text: string): string | null {
  if (text.trim() === '') return 'the article is empty';

  const length = documentLength(text);
  return length > MAX_DOCUMENT_CHARACTERS
    ? `the article has ${length} characters, the limit is ${MAX_DOCUMENT_CHARACTERS}`
    : null;
}

/**
 * One batch per article, holding every locale it is missing in. An article the
 * server would refuse for its text is refused here, before any request.
 */
export function buildDocumentBatches(
  missingDocuments: Record<string, MissingLocaleEntry>
): { batches: TranslationBatch[]; refused: DocumentRefusal[] } {
  const batchesByPath = new Map<string, TranslationBatch>();
  const refused = new Map<string, DocumentRefusal>();

  for (const [entryKey, entry] of Object.entries(missingDocuments)) {
    if (refused.has(entry.path)) continue;

    const existing = batchesByPath.get(entry.path);
    if (existing) {
      existing.localeEntries.push(entryKey);
      existing.locales.push(entry.locale);
      continue;
    }

    const name = documentKeyName(entry.path);
    const value = String(entry.keys[name]?.value ?? '');
    const reason = refusalReason(value);
    if (reason) {
      refused.set(entry.path, { path: entry.path, reason });
      continue;
    }

    batchesByPath.set(entry.path, {
      sourceFilePath: entry.path,
      sourceFile: {
        path: entry.path,
        format: WIRE_FORMAT_MARKDOWN,
        content: Buffer.from(JSON.stringify({ keys: { [name]: { value } } })).toString('base64')
      },
      localeEntries: [entryKey],
      locales: [entry.locale]
    });
  }

  return { batches: [...batchesByPath.values()], refused: [...refused.values()] };
}

interface SyncCell {
  path: string;
  translations: Array<{ key: string; value: unknown }>;
}

/**
 * A synced article arrives as one translation named after its file, holding the
 * whole text or null. Anything else would be written wrong, so the sync fails
 * before the first file is touched.
 */
export function validateDocumentCells(files: SyncCell[]): void {
  for (const file of files.filter(candidate => isDocumentPath(candidate.path))) {
    const [translation] = file.translations;
    const valid = file.translations.length === 1 &&
      translation.key === documentKeyName(file.path) &&
      (translation.value === null || typeof translation.value === 'string');
    if (!valid) {
      throw new Error(`Unexpected article content for ${file.path}. Nothing was written.`);
    }
  }
}
