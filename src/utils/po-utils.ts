import { po } from 'gettext-parser';

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
 * Convert .po entries to API compatible format
 */
export function poEntriesToApiFormat(entries: PoEntry[]): Record<string, any> {
  const keys: Record<string, any> = {};

  entries.forEach(entry => {
    const uniqueKey = createUniqueKey(entry.msgid, entry.msgctxt);

    let metadata: string | undefined;
    if (entry.comments?.extracted) {
      const extractedComments = Array.isArray(entry.comments.extracted)
        ? entry.comments.extracted
        : [entry.comments.extracted];

      const translatorComments = extractedComments
        .filter((comment: string) => comment.startsWith('Translators:'))
        .map((comment: string) => comment.replace(/^Translators:\s*/, '').trim())
        .filter((comment: string) => comment.length > 0);

      if (translatorComments.length > 0) {
        metadata = translatorComments.join(', ');
      }
    }

    const keyData: any = {
      value: (entry.msgstr && entry.msgstr[0]) || entry.msgid
    };

    if (metadata) {
      keyData.metadata = metadata;
    }

    if (entry.msgctxt) {
      keyData.context = entry.msgctxt;
    }

    keys[uniqueKey] = keyData;

    if (entry.msgid_plural) {
      const pluralKey = createUniqueKey(entry.msgid_plural, entry.msgctxt);
      const pluralKeyData: any = {
        value: (entry.msgstr && entry.msgstr[1]) || entry.msgid_plural
      };

      if (metadata) {
        pluralKeyData.metadata = metadata;
      }

      if (entry.msgctxt) {
        pluralKeyData.context = entry.msgctxt;
      }

      keys[pluralKey] = pluralKeyData;
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

  return po.compile(poData).toString();
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
  const sourceEntries = parsePoFile(sourceContent).entries;
  const targetEntries = parsePoFile(targetContent).entries;

  const targetMap = new Map<string, PoEntry>();
  targetEntries.forEach(entry => {
    const key = createUniqueKey(entry.msgid, entry.msgctxt);
    targetMap.set(key, entry);
  });

  const missing: MissingTranslation[] = [];

  sourceEntries.forEach(entry => {
    const key = createUniqueKey(entry.msgid, entry.msgctxt);
    const targetEntry = targetMap.get(key);

    // Check if translation is missing or empty
    const isEmpty = !targetEntry ||
      !targetEntry.msgstr ||
      !targetEntry.msgstr[0] ||
      targetEntry.msgstr[0].trim() === '';

    if (isEmpty) {
      missing.push({
        key: entry.msgid,
        context: entry.msgctxt,
        value: entry.msgid,
        isPlural: !!entry.msgid_plural,
        pluralForm: entry.msgid_plural
      });
    }
  });

  return missing;
}

/**
 * Update existing .po file with new translations
 */
export function updatePoFile(
  originalContent: string,
  translations: Record<string, string>
): string {
  const parsed = po.parse(originalContent);
  const updatedTranslations = new Set<string>();

  // Update existing translations
  Object.entries(parsed.translations).forEach(([context, entries]) => {
    if (typeof entries === 'object' && entries !== null) {
      Object.entries(entries).forEach(([msgid, entry]: [string, any]) => {
        if (msgid === '') return; // Skip header

        const uniqueKey = createUniqueKey(msgid, context !== '' ? context : undefined);

        if (translations[uniqueKey]) {
          if (entry.msgid_plural) {
            // Handle plural forms
            entry.msgstr[0] = translations[uniqueKey];
            const pluralKey = createUniqueKey(entry.msgid_plural, context !== '' ? context : undefined);
            if (translations[pluralKey]) {
              entry.msgstr[1] = translations[pluralKey];
            }
          } else {
            entry.msgstr = [translations[uniqueKey]];
          }
          updatedTranslations.add(uniqueKey);
        }
      });
    }
  });

  // Add new translations that weren't found in existing entries
  Object.entries(translations).forEach(([uniqueKey, value]) => {
    if (!updatedTranslations.has(uniqueKey)) {
      const { msgid, context } = parseUniqueKey(uniqueKey);
      const contextKey = context || '';

      // Skip if msgid is empty (this can happen with malformed keys)
      if (!msgid || msgid.trim() === '') {
        return;
      }

      // Initialize context if it doesn't exist
      if (!parsed.translations[contextKey]) {
        parsed.translations[contextKey] = {};
      }

      parsed.translations[contextKey][msgid] = {
        msgid: msgid,
        msgstr: [value]
      };
    }
  });

  return po.compile(parsed).toString();
}