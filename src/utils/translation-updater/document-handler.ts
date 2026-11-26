import { promises as fs } from 'fs';
import { ensureDirectoryExists } from './common.js';
import { documentKeyName } from '../documents.js';

export class DocumentWriteError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Cannot write article ${filePath}: ${reason}`);
    this.name = 'DocumentWriteError';
  }
}

interface DocumentWriteResult {
  updatedKeys: string[];
  created: boolean;
}

async function readIfExists(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function usesCrlf(text: string): boolean {
  const firstBreak = text.indexOf('\n');
  return firstBreak > 0 && text[firstBreak - 1] === '\r';
}

/**
 * A document is written whole: the value is the file. Nothing is trimmed or
 * added, since a changed byte would read as a person's edit on the next import.
 * Only the line endings follow the file already there, or the source for a new one.
 */
export async function writeDocumentFile(
  filePath: string,
  translations: Record<string, unknown>,
  sourceFilePath: string | null
): Promise<DocumentWriteResult> {
  const entries = Object.entries(translations);
  if (entries.length === 0) {
    return { updatedKeys: [], created: false };
  }

  const name = documentKeyName(filePath);
  if (entries.length > 1) {
    throw new DocumentWriteError(filePath, `expected one value, got ${entries.length}`);
  }
  const [key, value] = entries[0];
  if (key !== name) {
    throw new DocumentWriteError(filePath, `expected a value named ${name}, got ${key}`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocumentWriteError(filePath, 'the value is not a text');
  }

  const existing = await readIfExists(filePath);
  const reference = existing ?? await readIfExists(sourceFilePath);
  const text = reference !== null && usesCrlf(reference) ? value.replace(/\r?\n/g, '\r\n') : value;

  await ensureDirectoryExists(filePath);
  await fs.writeFile(filePath, text, 'utf8');

  return { updatedKeys: [name], created: existing === null };
}
