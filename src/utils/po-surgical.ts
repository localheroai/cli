import { po } from 'gettext-parser';
import { createUniqueKey, normalizeStringValue, parseUniqueKey, parsePoFile, PLURAL_SUFFIX } from './po-utils.js';

/**
 * Surgical update of .po file - only modify lines that actually changed
 * We create our own to able to better preserve the original formatting
 */
export function surgicalUpdatePoFile(
  originalContent: string,
  translations: Record<string, string>,
  options?: { sourceLanguage?: string; targetLanguage?: string; sourceContent?: string }
): string {
  // If no translations to apply, return original content unchanged
  if (Object.keys(translations).length === 0) {
    return originalContent;
  }

  // Quick check, if all translations match normalized content exactly,
  // return original unchanged to preserve formatting
  const parsed = po.parse(originalContent);
  let allIdentical = true;

  Object.entries(parsed.translations).forEach(([context, entries]) => {
    if (typeof entries === 'object' && entries !== null) {
      Object.entries(entries).forEach(([msgid, entry]: [string, any]) => {
        if (msgid === '') return; // Skip header

        const contextValue = context !== '' ? context : undefined;
        const uniqueKey = createUniqueKey(msgid, contextValue);

        if (translations[uniqueKey]) {
          const newValue = translations[uniqueKey];
          const currentValue = entry.msgid_plural
            ? normalizeStringValue(entry.msgstr[0] || '')
            : normalizeStringValue(entry.msgstr);
          const normalizedNewValue = normalizeStringValue(newValue);

          if (currentValue !== normalizedNewValue) {
            allIdentical = false;
          }
        }

        if (entry.msgid_plural) {
          const pluralKey = createUniqueKey(entry.msgid_plural, contextValue);
          const pluralSuffixKey = uniqueKey + PLURAL_SUFFIX;

          // Check for __plural_1 suffix key first, then fallback to msgid_plural key
          let newPluralValue = '';
          if (translations[pluralSuffixKey]) {
            newPluralValue = translations[pluralSuffixKey];
          } else if (translations[pluralKey] && entry.msgid_plural !== msgid) {
            newPluralValue = translations[pluralKey];
          }

          if (newPluralValue) {
            const currentPluralValue = normalizeStringValue(entry.msgstr[1] || '');
            const normalizedNewPluralValue = normalizeStringValue(newPluralValue);

            if (currentPluralValue !== normalizedNewPluralValue) {
              allIdentical = false;
            }
          }
        }
      });
    }
  });

  // Check if we have new entries to add, even if existing entries are identical
  const parsedForNewEntries = po.parse(originalContent);
  const hasNewEntries = hasNewEntriesToAdd(translations, parsedForNewEntries, options);

  if (allIdentical && !hasNewEntries) {
    return originalContent;
  }
  return processLineByLine(originalContent, translations, options);
}

/**
 * Group plural translations together
 */
function groupPluralTranslations(translations: Record<string, string>): {
  regular: Record<string, string>;
  pluralGroups: Map<string, { singular: string; plural: string }>;
} {
  const regular: Record<string, string> = {};
  const pluralGroups = new Map<string, { singular: string; plural: string }>();

  // First pass: identify plural pairs
  Object.keys(translations).forEach(key => {
    if (key.endsWith(PLURAL_SUFFIX)) {
      const baseKey = key.replace(new RegExp(PLURAL_SUFFIX + '$'), '');
      if (translations[baseKey]) {
        // This is a plural pair
        pluralGroups.set(baseKey, {
          singular: translations[baseKey],
          plural: translations[key]
        });
      }
    }
  });

  // Second pass: add regular keys (excluding those in plural pairs)
  Object.entries(translations).forEach(([key, value]) => {
    if (!key.endsWith(PLURAL_SUFFIX) && !pluralGroups.has(key)) {
      regular[key] = value;
    }
  });

  return { regular, pluralGroups };
}

/**
 * Check if a key exists in the parsed .po file
 */
function keyExistsInParsed(uniqueKey: string, parsed: any): boolean {
  const { msgid, context } = parseUniqueKey(uniqueKey);
  const contextKey = context || '';

  return parsed.translations[contextKey] && parsed.translations[contextKey][msgid];
}

/**
 * Check if a key is already used as msgid_plural in an existing entry
 */
function isUsedAsPluralForm(uniqueKey: string, parsed: any): boolean {
  const { msgid } = parseUniqueKey(uniqueKey);

  // Check all contexts for entries that use this msgid as msgid_plural
  for (const [, entries] of Object.entries(parsed.translations)) {
    if (typeof entries === 'object' && entries !== null) {
      for (const [entryMsgid, entry] of Object.entries(entries as any)) {
        if (entryMsgid !== '' && (entry as any).msgid_plural === msgid) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if there are new entries to add that don't exist in the original file
 */
function hasNewEntriesToAdd(
  translations: Record<string, string>,
  parsed: any,
  options?: { sourceLanguage?: string; targetLanguage?: string; sourceContent?: string }
): boolean {
  const { regular, pluralGroups } = groupPluralTranslations(translations);

  // Check for new regular entries
  for (const [uniqueKey, value] of Object.entries(regular)) {
    if (!keyExistsInParsed(uniqueKey, parsed)) {
      const { msgid } = parseUniqueKey(uniqueKey);

      // Skip malformed keys
      if (!msgid || msgid.trim() === '') {
        continue;
      }

      // Skip adding new entries where msgid === msgstr (source language files only)
      if (value === msgid && options?.sourceLanguage === options?.targetLanguage) {
        continue;
      }

      // Skip if this msgid is already used as msgid_plural in an existing entry
      if (isUsedAsPluralForm(uniqueKey, parsed)) {
        continue;
      }

      return true; // Found a new entry to add
    }
  }

  // Check for new plural entries
  for (const [uniqueKey] of pluralGroups) {
    if (!keyExistsInParsed(uniqueKey, parsed)) {
      const { msgid } = parseUniqueKey(uniqueKey);

      // Skip malformed keys
      if (!msgid || msgid.trim() === '') {
        continue;
      }

      return true; // Found a new plural entry to add
    }
  }

  return false; // No new entries to add
}

enum State {
  IDLE,
  IN_MSGCTXT,
  IN_MSGID,
  IN_MSGID_PLURAL,
  IN_MSGSTR,
  IN_MSGSTR_PLURAL
}

interface CurrentEntry {
  msgctxt?: string;
  msgid?: string;
  msgid_plural?: string;
  currentState: State;
  multilineBuffer: string[];
  pluralIndex?: number;
  entryStartLine: number;
}

/**
 * Process .po file line by line to make surgical updates
 */
function processLineByLine(
  content: string,
  translations: Record<string, string>,
  options?: { sourceLanguage?: string; targetLanguage?: string; sourceContent?: string }
): string {
  const lines = content.split('\n');
  const result: string[] = [];
  const parsed = po.parse(content);
  const changesToMake = new Map<string, string>();
  Object.entries(parsed.translations).forEach(([context, entries]) => {
    if (typeof entries === 'object' && entries !== null) {
      Object.entries(entries).forEach(([msgid, entry]: [string, any]) => {
        if (msgid === '') return; // Skip header

        const contextValue = context !== '' ? context : undefined;
        const uniqueKey = createUniqueKey(msgid, contextValue);

        if (translations[uniqueKey]) {
          const newValue = translations[uniqueKey];

          // Skip updating if this is a source language entry (msgid === msgstr)
          if (newValue === msgid && options?.sourceLanguage === options?.targetLanguage) {
            return;
          }

          // For plural forms, only compare the singular form (msgstr[0])
          const currentValue = entry.msgid_plural
            ? normalizeStringValue(entry.msgstr[0] || '')
            : normalizeStringValue(entry.msgstr);
          const normalizedNewValue = normalizeStringValue(newValue);

          if (currentValue !== normalizedNewValue) {
            changesToMake.set(uniqueKey, newValue);
          }
        }

        // Handle plural forms
        if (entry.msgid_plural) {
          const pluralKey = createUniqueKey(entry.msgid_plural, contextValue);
          const pluralSuffixKey = uniqueKey + PLURAL_SUFFIX;

          let pluralTranslationKey = '';
          let newPluralValue = '';

          if (translations[pluralSuffixKey]) {
            pluralTranslationKey = pluralSuffixKey;
            newPluralValue = translations[pluralSuffixKey];
          } else if (translations[pluralKey] && entry.msgid_plural !== msgid) {
            pluralTranslationKey = pluralKey;
            newPluralValue = translations[pluralKey];
          }

          if (pluralTranslationKey && newPluralValue) {
            const currentPluralValue = normalizeStringValue(entry.msgstr[1] || '');
            const normalizedNewPluralValue = normalizeStringValue(newPluralValue);

            if (currentPluralValue !== normalizedNewPluralValue) {
              changesToMake.set(pluralTranslationKey, newPluralValue);
            }
          }
        }
      });
    }
  });

  if (changesToMake.size === 0) {
    // Still need to add new entries even if no existing entries need changes
    const newEntries = addNewEntries(translations, parsed, changesToMake, options);
    if (newEntries.length > 0) {
      const lines = content.split('\n');
      lines.push('');
      lines.push(...newEntries);
      return lines.join('\n');
    }
    return content;
  }

  let currentEntry: CurrentEntry = {
    currentState: State.IDLE,
    multilineBuffer: [],
    entryStartLine: 0
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Handle comments - they can appear within entries, so don't reset state
    if (trimmedLine.startsWith('#')) {
      result.push(line);
      i++;
      continue;
    }

    // Handle empty lines - they separate entries, so reset state
    if (trimmedLine === '') {
      currentEntry = { currentState: State.IDLE, multilineBuffer: [], entryStartLine: i + 1 };
      result.push(line);
      i++;
      continue;
    }

    // Handle multiline context
    if (trimmedLine.startsWith('msgctxt ')) {
      // Start new context entry
      currentEntry = {
        msgctxt: extractMultilineValue(lines, i)[0],
        currentState: State.IN_MSGCTXT,
        multilineBuffer: [],
        entryStartLine: i
      };
      const { value, nextIndex } = extractMultilineValue(lines, i);
      currentEntry.msgctxt = unescapePoString(value);
      // Add all lines for this msgctxt
      for (let j = i; j < nextIndex; j++) {
        result.push(lines[j]);
      }
      i = nextIndex;
      currentEntry.currentState = State.IDLE;
      continue;
    }

    // Handle msgid
    if (trimmedLine.startsWith('msgid ')) {
      // Reset msgctxt if this msgid is not preceded by a msgctxt
      let hasContext = false;
      for (let j = i - 1; j >= 0; j--) {
        const prevLine = lines[j].trim();
        if (prevLine === '') continue;
        if (prevLine.startsWith('#')) continue;
        if (prevLine.startsWith('msgctxt ') || prevLine.startsWith('"')) {
          hasContext = true;
        }
        break;
      }

      if (!hasContext) {
        currentEntry.msgctxt = undefined;
      }

      const { value, nextIndex } = extractMultilineValue(lines, i);
      currentEntry.msgid = unescapePoString(value);
      currentEntry.currentState = State.IN_MSGID;

      // Add all lines for this msgid
      for (let j = i; j < nextIndex; j++) {
        result.push(lines[j]);
      }
      i = nextIndex;
      continue;
    }

    // Handle msgid_plural
    if (trimmedLine.startsWith('msgid_plural ')) {
      const { value, nextIndex } = extractMultilineValue(lines, i);
      currentEntry.msgid_plural = unescapePoString(value);
      currentEntry.currentState = State.IN_MSGID_PLURAL;

      // Add all lines for this msgid_plural
      for (let j = i; j < nextIndex; j++) {
        result.push(lines[j]);
      }
      i = nextIndex;
      continue;
    }

    // Handle msgstr
    if (trimmedLine.startsWith('msgstr ')) {
      currentEntry.currentState = State.IN_MSGSTR;
      const uniqueKey = createUniqueKey(currentEntry.msgid!, currentEntry.msgctxt);

      if (changesToMake.has(uniqueKey)) {
        const newValue = changesToMake.get(uniqueKey)!;
        const originalFormat = detectMsgstrFormat(lines, i);
        const formattedLines = formatMsgstrValue(newValue, originalFormat, 'msgstr');
        formattedLines.forEach(line => result.push(line));

        // Skip original msgstr lines
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
      } else {
        // Keep original - add all lines for this msgstr
        const { nextIndex } = extractMultilineValue(lines, i);
        for (let j = i; j < nextIndex; j++) {
          result.push(lines[j]);
        }
        i = nextIndex;
      }
      continue;
    }

    // Handle msgstr[n]
    const pluralMatch = trimmedLine.match(/^msgstr\[(\d+)\]\s/);
    if (pluralMatch) {
      const pluralIndex = parseInt(pluralMatch[1]);
      currentEntry.pluralIndex = pluralIndex;
      currentEntry.currentState = State.IN_MSGSTR_PLURAL;

      let keyToCheck: string;
      if (pluralIndex === 0) {
        keyToCheck = createUniqueKey(currentEntry.msgid!, currentEntry.msgctxt);
      } else {
        // For plural forms, check for the __plural_1 suffix key first
        const baseKey = createUniqueKey(currentEntry.msgid!, currentEntry.msgctxt);
        const pluralSuffixKey = baseKey + PLURAL_SUFFIX;

        // Try the __plural_1 key first, fall back to msgid_plural key
        if (changesToMake.has(pluralSuffixKey)) {
          keyToCheck = pluralSuffixKey;
        } else {
          keyToCheck = createUniqueKey(currentEntry.msgid_plural!, currentEntry.msgctxt);
          // For msgstr[1], only update if the msgid_plural is different from msgid
          // Otherwise msgstr[1] would get the same translation as msgstr[0]
          if (currentEntry.msgid_plural === currentEntry.msgid) {
            keyToCheck = ''; // Use empty key to prevent match
          }
        }
      }

      if (keyToCheck && changesToMake.has(keyToCheck)) {
        const newValue = changesToMake.get(keyToCheck)!;
        const originalFormat = detectMsgstrFormat(lines, i);
        const formattedLines = formatMsgstrValue(newValue, originalFormat, `msgstr[${pluralIndex}]`);
        formattedLines.forEach(line => result.push(line));

        // Skip original msgstr[n] lines
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
      } else {
        // Keep original - add all lines for this msgstr[n]
        const { nextIndex } = extractMultilineValue(lines, i);
        for (let j = i; j < nextIndex; j++) {
          result.push(lines[j]);
        }
        i = nextIndex;
      }
      continue;
    }

    // Handle continuation lines (lines starting with ")
    if (trimmedLine.startsWith('"') && currentEntry.currentState !== State.IDLE) {
      result.push(line);
      i++;
      continue;
    }

    // Default: pass through any other lines
    result.push(line);
    i++;
  }

  // Add new entries that don't exist in the original file
  const newEntries = addNewEntries(translations, parsed, changesToMake, options);
  if (newEntries.length > 0) {
    // Add new entries at the end
    result.push('');
    result.push(...newEntries);
  }

  return result.join('\n');
}

/**
 * Add new translation entries that don't exist in the original file
 */
function addNewEntries(
  translations: Record<string, string>,
  parsed: any,
  existingChanges: Map<string, string>,
  options?: { sourceLanguage?: string; targetLanguage?: string; sourceContent?: string }
): string[] {
  const result: string[] = [];
  const updatedTranslations = new Set<string>();

  // Track which translations were already handled as updates
  existingChanges.forEach((_, key) => {
    updatedTranslations.add(key);
  });

  // Group translations to handle plural forms
  const { regular, pluralGroups } = groupPluralTranslations(translations);

  // Add regular (non-plural) entries
  Object.entries(regular).forEach(([uniqueKey, value]) => {
    if (!updatedTranslations.has(uniqueKey) && !keyExistsInParsed(uniqueKey, parsed)) {
      const { msgid, context } = parseUniqueKey(uniqueKey);

      // Skip malformed keys
      if (!msgid || msgid.trim() === '') {
        return;
      }

      // Skip adding new entries where msgid === msgstr (source language files only)
      if (value === msgid && options?.sourceLanguage === options?.targetLanguage) {
        return;
      }

      // Skip if this msgid is already used as msgid_plural in an existing entry
      if (isUsedAsPluralForm(uniqueKey, parsed)) {
        return;
      }

      result.push(...createNewEntry(msgid, value, context));
      updatedTranslations.add(uniqueKey);
    }
  });

  // Add plural entries
  pluralGroups.forEach((pluralData, uniqueKey) => {
    if (!updatedTranslations.has(uniqueKey) && !keyExistsInParsed(uniqueKey, parsed)) {
      const { msgid, context } = parseUniqueKey(uniqueKey);

      // Skip malformed keys
      if (!msgid || msgid.trim() === '') {
        return;
      }

      const pluralKey = uniqueKey + PLURAL_SUFFIX;

      // Try to find the proper msgid_plural from the source file if available
      let msgid_plural = generateEnglishPlural(msgid); // fallback to simple pluralization

      if (options?.sourceContent) {
        try {
          const sourceParsed = parsePoFile(options.sourceContent);
          const sourceEntries = sourceParsed.entries;

          // Find the matching source entry with msgid_plural
          const sourceEntry = sourceEntries.find(entry => {
            const sourceKey = createUniqueKey(entry.msgid, entry.msgctxt);
            return sourceKey === uniqueKey && entry.msgid_plural;
          });

          if (sourceEntry && sourceEntry.msgid_plural) {
            msgid_plural = sourceEntry.msgid_plural;
          }
        } catch (error) {
          // If source parsing fails, continue with fallback
          console.warn('Failed to parse source content for msgid_plural lookup', error);
        }
      }

      result.push(...createNewPluralEntry(msgid, msgid_plural, pluralData.singular, pluralData.plural, context));

      // Mark both keys as updated
      updatedTranslations.add(uniqueKey);
      updatedTranslations.add(pluralKey);
    }
  });

  return result;
}

/**
 * Generate simple English plural form
 * This is a basic implementation for common cases
 */
function generateEnglishPlural(singular: string): string {
  if (!singular || singular.trim() === '') {
    return singular;
  }

  const text = singular.trim();

  // Handle strings with placeholders - find the last word that's likely a noun
  const words = text.split(/\s+/);
  let targetWordIndex = -1;
  let targetWord = '';

  // Look for the last word that could be a noun (not a placeholder, not a number)
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    // Skip placeholders like %(count)s, %d, {count}, etc.
    if (!word.match(/^[%{].*[}%sd]$/) && !word.match(/^\d+$/)) {
      targetWordIndex = i;
      targetWord = word;
      break;
    }
  }

  if (targetWordIndex === -1 || !targetWord) {
    // No suitable word found, return original
    return text;
  }
  // Pluralize the target word
  const pluralWord = pluralizeWord(targetWord);

  // Reconstruct the full string with the pluralized word
  const newWords = [...words];
  newWords[targetWordIndex] = pluralWord;
  return newWords.join(' ');
}

/**
 * Pluralize a single English word
 */
function pluralizeWord(word: string): string {
  if (!word) return word;

  // Handle common irregular plurals
  const irregulars: Record<string, string> = {
    'child': 'children',
    'person': 'people',
    'man': 'men',
    'woman': 'women',
    'tooth': 'teeth',
    'foot': 'feet',
    'mouse': 'mice',
    'goose': 'geese'
  };

  // Check for irregular plurals (case insensitive, but preserve original case)
  const lowerWord = word.toLowerCase();
  if (irregulars[lowerWord]) {
    // Preserve the case pattern of the original word
    const irregular = irregulars[lowerWord];
    if (word === word.toUpperCase()) {
      return irregular.toUpperCase();
    } else if (word[0] === word[0].toUpperCase()) {
      return irregular.charAt(0).toUpperCase() + irregular.slice(1);
    }
    return irregular;
  }

  // Handle words ending in consonant + y -> ies
  if (word.length > 1 && word.endsWith('y') && !'aeiou'.includes(word[word.length - 2].toLowerCase())) {
    return word.slice(0, -1) + 'ies';
  }

  // Handle words ending in s, ss, sh, ch, x, z -> es
  if (word.match(/[sxz]$/) || word.match(/(sh|ch)$/)) {
    return word + 'es';
  }

  // Handle words ending in f or fe -> ves
  if (word.endsWith('f')) {
    return word.slice(0, -1) + 'ves';
  }
  if (word.endsWith('fe')) {
    return word.slice(0, -2) + 'ves';
  }

  // Default: add 's'
  return word + 's';
}

/**
 * Create a new regular translation entry
 */
function createNewEntry(msgid: string, msgstr: string, context?: string): string[] {
  const result: string[] = [];

  if (context) {
    result.push(`msgctxt "${escapePoString(context)}"`);
  }

  result.push(`msgid "${escapePoString(msgid)}"`);
  result.push(`msgstr "${escapePoString(msgstr)}"`);

  return result;
}

/**
 * Create a new plural translation entry
 */
function createNewPluralEntry(
  msgid: string,
  msgid_plural: string,
  singular: string,
  plural: string,
  context?: string
): string[] {
  const result: string[] = [];

  if (context) {
    result.push(`msgctxt "${escapePoString(context)}"`);
  }

  result.push(`msgid "${escapePoString(msgid)}"`);
  result.push(`msgid_plural "${escapePoString(msgid_plural)}"`);
  result.push(`msgstr[0] "${escapePoString(singular)}"`);
  result.push(`msgstr[1] "${escapePoString(plural)}"`);

  return result;
}

/**
 * Extract multiline value starting from a msgctxt, msgid, or msgstr line
 */
function extractMultilineValue(lines: string[], startIndex: number): { value: string, nextIndex: number } {
  let value = '';
  let i = startIndex;
  const firstLine = lines[i];

  // Extract initial quoted value
  const match = firstLine.match(/^\s*msg\w+(?:\[\d+\])?\s+"(.*)"\s*$/) ||
    firstLine.match(/^\s*msgctxt\s+"(.*)"\s*$/);
  if (match) {
    value = match[1];
  }

  i++;

  // Look for continuation lines
  while (i < lines.length && lines[i].trim().startsWith('"')) {
    const continuationMatch = lines[i].match(/^\s*"(.*)"\s*$/);
    if (continuationMatch) {
      value += continuationMatch[1];
    }
    i++;
  }

  return { value, nextIndex: i };
}


function escapePoString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function unescapePoString(str: string): string {
  return str
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

interface MsgstrFormat {
  isMultiline: boolean;
  hasEmptyFirstLine: boolean;
  maxLineLength: number;
  indentation: string;
}

function detectMsgstrFormat(lines: string[], startIndex: number): MsgstrFormat {
  const format: MsgstrFormat = {
    isMultiline: false,
    hasEmptyFirstLine: false,
    maxLineLength: 80,
    indentation: ''
  };

  let i = startIndex;
  const msgstrLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop if we hit the next entry or empty line
    if (trimmed === '' || (!trimmed.startsWith('"') && !trimmed.startsWith('msgstr'))) {
      break;
    }

    msgstrLines.push(line);
    i++;
  }

  if (msgstrLines.length === 0) {
    return format;
  }

  // Analyze the first line to get indentation
  const firstLine = msgstrLines[0];
  const match = firstLine.match(/^(\s*)msgstr(?:\[\d+\])?\s+"(.*)"\s*$/);

  if (match) {
    format.indentation = match[1];
    const firstContent = match[2];

    // Check if it's multiline (has continuation lines)
    format.isMultiline = msgstrLines.length > 1;

    // If multiline, check if first line is empty
    if (format.isMultiline) {
      format.hasEmptyFirstLine = firstContent === '';

      // Calculate max line length from continuation lines
      const continuationLines = msgstrLines.slice(1);
      format.maxLineLength = Math.max(
        ...continuationLines.map(line => line.length),
        80 // minimum default
      );
    } else {
      format.hasEmptyFirstLine = false;
      format.maxLineLength = firstLine.length;
    }
  }

  return format;
}

function formatMsgstrValue(value: string, format: MsgstrFormat, msgstrPrefix: string): string[] {
  const lines: string[] = [];

  // Preserve single-line format if original was single-line and new value is reasonable length
  if (!format.isMultiline && value.length <= 120 && !value.includes('\n')) {
    lines.push(`${format.indentation}${msgstrPrefix} "${escapePoString(value)}"`);
    return lines;
  }

  // Use multiline format (original was multiline)
  if (format.hasEmptyFirstLine) {
    lines.push(`${format.indentation}${msgstrPrefix} ""`);
  } else {
    lines.push(`${format.indentation}${msgstrPrefix} ""`);
  }

  // For multiline, try to preserve original line breaking patterns when possible
  // Split by actual newlines first
  const contentLines = value.split('\n');

  contentLines.forEach((contentLine, index) => {
    const isLastLine = index === contentLines.length - 1;
    const lineContent = escapePoString(contentLine);
    const suffix = isLastLine ? '' : '\\n';

    // If line is reasonably short, add as single continuation line
    if ((lineContent + suffix).length <= format.maxLineLength) {
      lines.push(`${format.indentation}"${lineContent}${suffix}"`);
    } else {
      // Break long line into chunks at word boundaries
      const maxContentLength = Math.max(60, format.maxLineLength - 10); // Leave room for quotes and suffix
      const words = lineContent.split(' ');
      let currentChunk = '';

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const spaceIfNeeded = currentChunk ? ' ' : '';
        const wouldBeLength = currentChunk.length + spaceIfNeeded.length + word.length;

        if (wouldBeLength <= maxContentLength || !currentChunk) {
          currentChunk += spaceIfNeeded + word;
        } else {
          lines.push(`${format.indentation}"${currentChunk} "`);
          currentChunk = word;
        }
      }

      if (currentChunk) {
        lines.push(`${format.indentation}"${currentChunk}${suffix}"`);
      }
    }
  });

  return lines;
}
