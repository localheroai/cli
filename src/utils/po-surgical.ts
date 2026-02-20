import { po } from 'gettext-parser';
import { createUniqueKey, normalizeStringValue, parseUniqueKey, parsePoFile, PLURAL_PREFIX, extractNPlurals, MAX_PLURAL_FORMS } from './po-utils.js';

/**
 * Surgical update of .po file - only modify lines that actually changed
 * We create our own to able to better preserve the original formatting
 */
export function surgicalUpdatePoFile(
  originalContent: string,
  translations: Record<string, string>,
  options?: {
    sourceLanguage?: string;
    targetLanguage?: string;
    sourceContent?: string;
    keyMappings?: Record<string, string>; // Map of old keys to new keys (for PO versioning)
  }
): string {
  // If keyMappings are provided, skip the allIdentical optimization
  // because we need to update msgids even if values are identical
  const hasKeyMappings = options?.keyMappings && Object.keys(options.keyMappings).length > 0;

  // If no translations to apply and no key mappings, return original content unchanged
  if (Object.keys(translations).length === 0 && !hasKeyMappings) {
    return originalContent;
  }

  if (hasKeyMappings) {
    return processLineByLine(originalContent, translations, options);
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

          // Check for msgid_plural key
          let newPluralValue = '';
          if (translations[pluralKey] && entry.msgid_plural !== msgid) {
            newPluralValue = translations[pluralKey];
          }

          if (newPluralValue) {
            const currentPluralValue = normalizeStringValue(entry.msgstr[1] || '');
            const normalizedNewPluralValue = normalizeStringValue(newPluralValue);

            if (currentPluralValue !== normalizedNewPluralValue) {
              allIdentical = false;
            }
          }

          // Check for __plural_N keys
          for (let i = 1; i < entry.msgstr.length; i++) {
            const pluralKey = uniqueKey + `${PLURAL_PREFIX}${i}`;
            if (translations[pluralKey]) {
              const currentPluralValue = normalizeStringValue(entry.msgstr[i] || '');
              const newPluralValue = translations[pluralKey];
              const normalizedNewPluralValue = normalizeStringValue(newPluralValue);

              if (currentPluralValue !== normalizedNewPluralValue) {
                allIdentical = false;
              }
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
  pluralGroups: Map<string, string[]>;
} {
  const regular: Record<string, string> = {};
  const pluralGroups = new Map<string, string[]>();

  // First pass: identify plural groups by base key
  Object.keys(translations).forEach(key => {
    const pluralMatch = key.match(/^(.+)__plural_(\d+)$/);
    if (pluralMatch) {
      const baseKey = pluralMatch[1];
      const pluralIndex = parseInt(pluralMatch[2]);

      if (!pluralGroups.has(baseKey)) {
        pluralGroups.set(baseKey, []);
      }

      // Validate plural index bounds
      if (pluralIndex >= 0 && pluralIndex <= MAX_PLURAL_FORMS) {
        const pluralArray = pluralGroups.get(baseKey)!;
        while (pluralArray.length <= pluralIndex) {
          pluralArray.push('');
        }
        pluralArray[pluralIndex] = translations[key];
      } else {
        console.warn(`Invalid plural index ${pluralIndex} for key ${baseKey}, skipping`);
      }
    }
  });

  // Second pass: add base keys (msgstr[0]) to plural groups if they exist
  Object.entries(translations).forEach(([key, value]) => {
    if (pluralGroups.has(key)) {
      // This is a base key of a plural group
      const pluralArray = pluralGroups.get(key)!;
      if (pluralArray.length === 0) {
        pluralArray.push(value);
      } else {
        pluralArray[0] = value;
      }
    } else if (!key.match(/__plural_\d+$/)) {
      // Regular (non-plural) key
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
  versionedNewMsgid?: string; // Tracks the new msgid when key versioning is applied
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
  options?: {
    sourceLanguage?: string;
    targetLanguage?: string;
    sourceContent?: string;
    keyMappings?: Record<string, string>;
  }
): string {
  const lines = content.split('\n');
  const result: string[] = [];
  const parsed = po.parse(content);
  const changesToMake = new Map<string, string>();
  const msgidChanges = new Map<string, string>(); // Map old msgid → new msgid (for versioning)
  const entriesToRemove = new Set<string>(); // Entries to remove when target msgid already exists (merge case)

  // PO Key Versioning: When a key's source text (msgid) changes in the UI,
  // the backend creates a new key version and provides the old msgid in old_values.
  // We need to find the entry by the OLD msgid and update it to the NEW msgid.
  Object.entries(parsed.translations).forEach(([context, entries]) => {
    if (typeof entries === 'object' && entries !== null) {
      Object.entries(entries).forEach(([msgid, entry]: [string, any]) => {
        if (msgid === '') return; // Skip header

        const contextValue = context !== '' ? context : undefined;
        const uniqueKey = createUniqueKey(msgid, contextValue);

        let actualNewKey = uniqueKey;
        let foundViaMapping = false;

        if (options?.keyMappings) {
          const mappedNewKey = options.keyMappings[uniqueKey];
          if (mappedNewKey) {
            actualNewKey = mappedNewKey;
            foundViaMapping = true;

            if (keyExistsInParsed(mappedNewKey, parsed)) {
              entriesToRemove.add(uniqueKey);
            } else {
              const { msgid: newMsgid } = parseUniqueKey(mappedNewKey);
              msgidChanges.set(uniqueKey, newMsgid);
            }
          }
        }

        if (entriesToRemove.has(uniqueKey)) {
          return;
        }

        if (translations[actualNewKey]) {
          const newValue = translations[actualNewKey];

          // Skip updating if this is a source language entry (msgid === msgstr)
          if (newValue === msgid && options?.sourceLanguage === options?.targetLanguage) {
            return;
          }

          // For plural forms, only compare the singular form (msgstr[0])
          const currentValue = entry.msgid_plural
            ? normalizeStringValue(entry.msgstr[0] || '')
            : normalizeStringValue(entry.msgstr);
          const normalizedNewValue = normalizeStringValue(newValue);

          if (currentValue !== normalizedNewValue || foundViaMapping) {
            changesToMake.set(uniqueKey, newValue);
            // Also track the new key so addNewEntries doesn't add it as a duplicate
            if (foundViaMapping && actualNewKey !== uniqueKey) {
              changesToMake.set(actualNewKey, newValue);
            }
          }
        }

        if (entry.msgid_plural) {
          const actualPluralCount = entry.msgstr.length;

          // Check for plural forms for this specific key
          for (let i = 1; i < actualPluralCount; i++) {
            const oldPluralKey = uniqueKey + `${PLURAL_PREFIX}${i}`;
            const newPluralKey = actualNewKey + `${PLURAL_PREFIX}${i}`;
            const translationKey = translations[newPluralKey] ? newPluralKey : oldPluralKey;

            if (translations[translationKey]) {
              const currentPluralValue = normalizeStringValue(entry.msgstr[i] || '');
              const newPluralValue = translations[translationKey];
              const normalizedNewPluralValue = normalizeStringValue(newPluralValue);

              if (currentPluralValue !== normalizedNewPluralValue || foundViaMapping) {
                changesToMake.set(oldPluralKey, newPluralValue);
                // Also track the new plural key so addNewEntries doesn't add it as a duplicate
                if (foundViaMapping && newPluralKey !== oldPluralKey) {
                  changesToMake.set(newPluralKey, newPluralValue);
                }
              }
            }
          }

          const pluralKey = createUniqueKey(entry.msgid_plural, contextValue);
          if (translations[pluralKey] && entry.msgid_plural !== msgid) {
            const currentPluralValue = normalizeStringValue(entry.msgstr[1] || '');
            const normalizedNewPluralValue = normalizeStringValue(translations[pluralKey]);

            if (currentPluralValue !== normalizedNewPluralValue) {
              changesToMake.set(pluralKey, translations[pluralKey]);
            }
          }
        }
      });
    }
  });

  if (changesToMake.size === 0 && entriesToRemove.size === 0) {
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

  let entryContentStartIndex = 0;
  let skippingEntry = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Handle comments - they can appear within entries, so don't reset state
    if (trimmedLine.startsWith('#')) {
      if (!skippingEntry) {
        result.push(line);
      }
      i++;
      continue;
    }

    // Handle empty lines - they separate entries, so reset state
    if (trimmedLine === '') {
      if (!skippingEntry) {
        result.push(line);
      }
      skippingEntry = false;
      currentEntry = { currentState: State.IDLE, multilineBuffer: [], entryStartLine: i + 1 };
      entryContentStartIndex = result.length;
      i++;
      continue;
    }

    // Handle multiline context
    if (trimmedLine.startsWith('msgctxt ')) {
      if (skippingEntry) {
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
        continue;
      }
      const { value, nextIndex } = extractMultilineValue(lines, i);
      currentEntry = {
        msgctxt: unescapePoString(value),
        currentState: State.IN_MSGCTXT,
        multilineBuffer: [],
        entryStartLine: i
      };
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

      const uniqueKey = createUniqueKey(currentEntry.msgid, currentEntry.msgctxt);

      if (entriesToRemove.has(uniqueKey)) {
        result.length = entryContentStartIndex;
        skippingEntry = true;
        i = nextIndex;
        continue;
      }

      const newMsgid = msgidChanges.get(uniqueKey);
      if (newMsgid) {
        currentEntry.versionedNewMsgid = newMsgid;
        result.push(`msgid "${escapePoString(newMsgid)}"`);
      } else {
        for (let j = i; j < nextIndex; j++) {
          result.push(lines[j]);
        }
      }

      i = nextIndex;
      continue;
    }

    // Handle msgid_plural
    if (trimmedLine.startsWith('msgid_plural ')) {
      if (skippingEntry) {
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
        continue;
      }
      const { value, nextIndex } = extractMultilineValue(lines, i);
      currentEntry.msgid_plural = unescapePoString(value);
      currentEntry.currentState = State.IN_MSGID_PLURAL;

      // Only update msgid_plural when versioning is active (versionedNewMsgid was set)
      // The __plural_1 translation value becomes the new msgid_plural text
      let newMsgidPlural: string | undefined;
      if (currentEntry.versionedNewMsgid) {
        const uniqueKey = createUniqueKey(currentEntry.versionedNewMsgid, currentEntry.msgctxt);
        const pluralKey = uniqueKey + '__plural_1';
        if (translations[pluralKey]) {
          newMsgidPlural = translations[pluralKey];
        }
      }

      if (newMsgidPlural) {
        result.push(`msgid_plural "${escapePoString(newMsgidPlural)}"`);
      } else {
        for (let j = i; j < nextIndex; j++) {
          result.push(lines[j]);
        }
      }
      i = nextIndex;
      continue;
    }

    // Handle msgstr
    if (trimmedLine.startsWith('msgstr ')) {
      if (skippingEntry) {
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
        continue;
      }
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
      if (skippingEntry) {
        const { nextIndex } = extractMultilineValue(lines, i);
        i = nextIndex;
        continue;
      }
      const pluralIndex = parseInt(pluralMatch[1]);
      currentEntry.pluralIndex = pluralIndex;
      currentEntry.currentState = State.IN_MSGSTR_PLURAL;

      let keyToCheck: string;
      if (pluralIndex === 0) {
        keyToCheck = createUniqueKey(currentEntry.msgid!, currentEntry.msgctxt);
      } else {
        const baseKey = createUniqueKey(currentEntry.msgid!, currentEntry.msgctxt);
        const pluralSuffixKey = baseKey + `${PLURAL_PREFIX}${pluralIndex}`;

        // Try the ${PLURAL_PREFIX}N suffix key first, fall back to msgid_plural key for backward compatibility
        if (changesToMake.has(pluralSuffixKey)) {
          keyToCheck = pluralSuffixKey;
        } else {
          keyToCheck = createUniqueKey(currentEntry.msgid_plural!, currentEntry.msgctxt);
          // For msgstr[N], only update if the msgid_plural is different from msgid
          // Otherwise msgstr[N] would get the same translation as msgstr[0]
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

      let msgid_plural: string | null = null;

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
          if (error instanceof SyntaxError) {
            console.warn('Failed to parse source content for msgid_plural lookup: Invalid PO syntax');
          } else {
            console.warn('Failed to parse source content for msgid_plural lookup', error);
          }
        }
      }

      if (!msgid_plural) {
        console.warn(`Skipping plural entry creation for '${msgid}' - no msgid_plural found in source content. Provide sourceContent with proper plural forms to enable plural translation support.`);
        return;
      }

      // Extract nplurals from the target file's headers
      const targetNplurals = extractNPlurals(parsed.headers || {});

      result.push(...createNewPluralEntry(msgid, msgid_plural, pluralData, context, targetNplurals));

      // Mark all plural keys as updated
      updatedTranslations.add(uniqueKey);
      pluralData.forEach((_, index) => {
        if (index > 0) {
          updatedTranslations.add(uniqueKey + `${PLURAL_PREFIX}${index}`);
        }
      });
    }
  });

  return result;
}

/**
 * Create a new regular translation entry
 */
function createNewEntry(msgid: string, msgstr: string, context?: string): string[] {
  const result: string[] = [];

  result.push('');

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
  translations: string[],
  context?: string,
  nplurals: number = 2
): string[] {
  const result: string[] = [];

  result.push('');

  if (context) {
    result.push(`msgctxt "${escapePoString(context)}"`);
  }

  result.push(`msgid "${escapePoString(msgid)}"`);
  result.push(`msgid_plural "${escapePoString(msgid_plural)}"`);

  // Write all required plural forms for the target language
  for (let i = 0; i < nplurals; i++) {
    const translation = translations[i] || ''; // Use empty string if no translation provided
    result.push(`msgstr[${i}] "${escapePoString(translation)}"`);
  }

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
  let isFirstLine = true;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop if we hit an empty line
    if (trimmed === '') {
      break;
    }

    // For the first line, it must be a msgstr line
    if (isFirstLine) {
      if (!trimmed.startsWith('msgstr')) {
        break;
      }
      isFirstLine = false;
    } else {
      // For subsequent lines, only continuation lines (starting with ") are part of this entry
      // Stop if we hit another msgstr, msgid, msgctxt, or comment
      if (!trimmed.startsWith('"')) {
        break;
      }
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

  // Handle empty values as single-line entries
  if (!value || value.trim() === '') {
    lines.push(`${format.indentation}${msgstrPrefix} ""`);
    return lines;
  }

  // Preserve single-line format if original was single-line and new value is reasonable length
  // Also prefer single-line for very short values when original was multiline but essentially empty
  if (!format.isMultiline && value.length <= 120 && !value.includes('\n')) {
    lines.push(`${format.indentation}${msgstrPrefix} "${escapePoString(value)}"`);
    return lines;
  }

  // For multiline originals with empty first line, only convert to single-line if the value is very short
  if (format.isMultiline && format.hasEmptyFirstLine && value.length <= 40 && !value.includes('\n')) {
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
