import path from 'path';
import type { DocumentFormat } from '../types/index.js';

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
