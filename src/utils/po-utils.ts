import { po } from 'gettext-parser';

export const PLURAL_PREFIX = '__plural_';
export const MAX_PLURAL_FORMS = 10; // Covers MANY languages: Arabic=6, Russian=3, etc.
export const PLURAL_SUFFIX_REGEX = new RegExp(`${PLURAL_PREFIX}\\d+$`);

/**
 * Extract base keys from a set of keys (removing plural suffixes)
 * For example: "item__plural_1" -> "item", "item" -> "item"
 */
export function extractBaseKeys(keys: Set<string>): Set<string> {
  const baseKeys = new Set<string>();
  for (const key of keys) {
    const baseKey = key.replace(PLURAL_SUFFIX_REGEX, '');
    baseKeys.add(baseKey);
  }
  return baseKeys;
}

/**
 * Extract the number of plural forms from PO file headers
 */
export function extractNPlurals(headers: Record<string, string>): number {
  if (!headers || typeof headers !== 'object') {
    return 2; // default fallback
  }

  const pluralForms = headers['plural-forms'] || headers['Plural-Forms'];
  if (pluralForms && typeof pluralForms === 'string') {
    const match = pluralForms.match(/nplurals\s*=\s*(\d+)/);
    if (match && match[1]) {
      const nplurals = parseInt(match[1], 10);
      // Validate reasonable range and ensure it's a valid number
      if (!isNaN(nplurals) && nplurals >= 1 && nplurals <= MAX_PLURAL_FORMS) {
        return nplurals;
      }
      console.warn(`Invalid nplurals value: ${nplurals}, using default of 2`);
    }
  }
  return 2; // default fallback
}

export interface PoEntry {
  msgid: string;
  msgstr: string[];
  msgctxt?: string;
  msgid_plural?: string;
  comments?: {
    reference?: string[];
    extracted?: string[];
    flag?: string[];
    previous?: string;
  };
}

export interface ParsedPoFile {
  headers: Record<string, string>;
  entries: PoEntry[];
}

/**
 * Parse a .po file content and extract entries
 */
export function parsePoFile(content: string): ParsedPoFile {
  const parsed = po.parse(content);
  const headers = parsed.headers || {};
  const entries: PoEntry[] = [];

  Object.entries(parsed.translations).forEach(([context, translations]) => {
    if (typeof translations === 'object' && translations !== null) {
      Object.entries(translations).forEach(([msgid, entry]: [string, any]) => {
        // Skip the empty header entry that is always present
        if (msgid === '') return;

        entries.push({
          msgid,
          msgstr: entry.msgstr || [''],
          msgctxt: context !== '' ? context : undefined,
          msgid_plural: entry.msgid_plural,
          comments: entry.comments
        });
      });
    }
  });

  return { headers, entries };
}

/**
 * Create unique key for storage using "context|msgid" format
 */
export function createUniqueKey(msgid: string, context?: string): string {
  return context ? `${context}|${msgid}` : msgid;
}

/**
 * Parse key back to msgid and context
 */
export function parseUniqueKey(key: string): { msgid: string; context?: string } {
  const pipeIndex = key.indexOf('|');
  if (pipeIndex === -1) {
    return { msgid: key };
  }

  return {
    context: key.substring(0, pipeIndex),
    msgid: key.substring(pipeIndex + 1)
  };
}

/**
 * Convert .po file to API compatible format
 */
export function poEntriesToApiFormat(
  parsed: ParsedPoFile,
  options?: { sourceLanguage?: string; currentLanguage?: string }
): Record<string, any> {
  const keys: Record<string, any> = {};
  const nplurals = extractNPlurals(parsed.headers);

  parsed.entries.forEach(entry => {
    const uniqueKey = createUniqueKey(entry.msgid, entry.msgctxt);

    let translatorComments: string | undefined;
    if (entry.comments?.extracted) {
      const extractedComments = Array.isArray(entry.comments.extracted)
        ? entry.comments.extracted
        : [entry.comments.extracted];

      const comments = extractedComments
        .filter((comment: string) => comment.startsWith('Translators:'))
        .map((comment: string) => comment.replace(/^Translators:\s*/, '').trim())
        .filter((comment: string) => comment.length > 0);

      if (comments.length > 0) {
        translatorComments = comments.join(', ');
      }
    }

    if (entry.msgid_plural) {
      const isSourceLanguage = options?.sourceLanguage && options?.currentLanguage &&
        options.sourceLanguage === options.currentLanguage;

      // Generate all plural forms based on nplurals
      for (let i = 0; i < nplurals; i++) {
        const suffix = i === 0 ? '' : `${PLURAL_PREFIX}${i}`;
        const keyName = uniqueKey + suffix;
        const value = entry.msgstr && entry.msgstr[i] ? entry.msgstr[i] :
          (isSourceLanguage ? (i === 0 ? entry.msgid : entry.msgid_plural) : '');

        const keyData: any = {
          value,
          metadata: {
            po_plural: true,
            plural_index: i
          }
        };

        if (i === 0) {
          keyData.metadata.msgid_plural = entry.msgid_plural;
        } else {
          keyData.metadata.msgid = entry.msgid;
        }

        if (translatorComments) {
          keyData.metadata.translator_comments = translatorComments;
        }

        if (entry.msgctxt) {
          keyData.context = entry.msgctxt;
        }

        keys[keyName] = keyData;
      }
    } else {
      // Handle regular (non-plural) entries
      const isSourceLanguage = options?.sourceLanguage && options?.currentLanguage &&
        options.sourceLanguage === options.currentLanguage;
      const value = entry.msgstr && entry.msgstr[0] ? entry.msgstr[0] :
        (isSourceLanguage ? entry.msgid : '');

      const keyData: any = {
        value: value
      };

      if (translatorComments) {
        keyData.metadata = {
          translator_comments: translatorComments
        };
      }

      if (entry.msgctxt) {
        keyData.context = entry.msgctxt;
      }

      keys[uniqueKey] = keyData;
    }
  });

  return keys;
}

/**
 * Create .po file content
 */
export function createPoFile(entries: PoEntry[], headers?: Record<string, string>): string {
  const poData: any = {
    headers: headers || {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Language': 'en'
    },
    translations: {}
  };

  // Group entries by context
  entries.forEach(entry => {
    const context = entry.msgctxt || '';

    if (!poData.translations[context]) {
      poData.translations[context] = {};
    }

    const translationEntry: any = {
      msgstr: entry.msgstr
    };

    if (entry.msgid_plural) {
      translationEntry.msgid_plural = entry.msgid_plural;
    }

    if (entry.comments) {
      translationEntry.comments = entry.comments;
    }

    poData.translations[context][entry.msgid] = translationEntry;
  });

  // For new files, disable folding to avoid arbitrary line breaks
  return po.compile(poData, { foldLength: 0 }).toString();
}

/**
 * Find missing translations by comparing source and target .po files
 */
export interface MissingTranslation {
  key: string;
  context?: string;
  value: string;
  isPlural: boolean;
  pluralForm?: string;
}

export function findMissingPoTranslations(
  sourceContent: string,
  targetContent: string
): MissingTranslation[] {
  const sourceParsed = parsePoFile(sourceContent);
  const targetParsed = parsePoFile(targetContent);
  const sourceEntries = sourceParsed.entries;
  const targetEntries = targetParsed.entries;

  // Use target file's nplurals to determine how many plural forms to check for
  const targetNplurals = extractNPlurals(targetParsed.headers);

  const targetMap = new Map<string, PoEntry>();
  targetEntries.forEach(entry => {
    const key = createUniqueKey(entry.msgid, entry.msgctxt);
    targetMap.set(key, entry);
  });

  const missing: MissingTranslation[] = [];

  sourceEntries.forEach(entry => {
    const key = createUniqueKey(entry.msgid, entry.msgctxt);
    const targetEntry = targetMap.get(key);

    if (entry.msgid_plural) {
      for (let i = 0; i < targetNplurals; i++) {
        const isEmpty = !targetEntry ||
          !targetEntry.msgstr ||
          !targetEntry.msgstr[i] ||
          targetEntry.msgstr[i].trim() === '';

        if (isEmpty) {
          const suffix = i === 0 ? '' : `${PLURAL_PREFIX}${i}`;
          const keyName = key + suffix;

          missing.push({
            key: keyName,
            context: entry.msgctxt,
            value: i === 0 ? entry.msgid : entry.msgid_plural,
            isPlural: true,
            pluralForm: entry.msgid_plural
          });
        }
      }
    } else {
      // Handle regular (non-plural) entries
      const isEmpty = !targetEntry ||
        !targetEntry.msgstr ||
        !targetEntry.msgstr[0] ||
        targetEntry.msgstr[0].trim() === '';

      if (isEmpty) {
        missing.push({
          key: entry.msgid,
          context: entry.msgctxt,
          value: entry.msgid,
          isPlural: false,
          pluralForm: entry.msgid_plural
        });
      }
    }
  });

  return missing;
}

/**
 * Normalize a string value by joining multiline parts and trimming
 * This handles cases where gettext line wrapping differs but content is identical
 */
export function normalizeStringValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.join('').trim();
  }
  return (value || '').trim();
}
