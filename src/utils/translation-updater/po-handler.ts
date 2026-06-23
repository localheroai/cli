import { readFile, writeFile } from 'fs/promises';
import { fileExists } from './common.js';
import {
  PLURAL_SUFFIX_REGEX,
  parseUniqueKey,
  parsePoFile,
  createPoFile,
  type PoEntry
} from '../po-utils.js';
import { surgicalUpdatePoFile } from '../po-surgical.js';
import type { TranslationWithMetadata } from '../../types/index.js';

const PLURAL_FORM_RULES: Record<string, string> = {
  ar: 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);',
  be: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  bs: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  br: 'nplurals=5; plural=(n%10==1 && n%100!=11 && n%100!=71 && n%100!=91 ? 0 : n%10==2 && n%100!=12 && n%100!=72 && n%100!=92 ? 1 : (n%10==3 || n%10==4 || n%10==9) && (n%100<10 || n%100>19) && (n%100<70 || n%100>79) && (n%100<90 || n%100>99) ? 2 : n!=0 && n%1000000==0 ? 3 : 4);',
  cs: 'nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);',
  cy: 'nplurals=4; plural=(n==1 ? 0 : n==2 ? 1 : n==8 || n==11 ? 2 : 3);',
  ga: 'nplurals=5; plural=(n==1 ? 0 : n==2 ? 1 : n<7 ? 2 : n<11 ? 3 : 4);',
  gd: 'nplurals=4; plural=(n==1 || n==11 ? 0 : n==2 || n==12 ? 1 : n>2 && n<20 ? 2 : 3);',
  hr: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  lt: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2);',
  lv: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n!=0 ? 1 : 2);',
  mk: 'nplurals=2; plural=(n==1 || n%10==1 ? 0 : 1);',
  mt: 'nplurals=4; plural=(n==1 ? 0 : n==0 || (n%100>1 && n%100<11) ? 1 : n%100>10 && n%100<20 ? 2 : 3);',
  pl: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  ro: 'nplurals=3; plural=(n==1 ? 0 : n==0 || (n%100>0 && n%100<20) ? 1 : 2);',
  ru: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  sk: 'nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);',
  sl: 'nplurals=4; plural=(n%100==1 ? 0 : n%100==2 ? 1 : n%100==3 || n%100==4 ? 2 : 3);',
  sr: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
  uk: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'
};

const ONE_FORM_LANGUAGES = new Set([
  'az', 'id', 'ja', 'ka', 'km', 'ko', 'lo', 'ms', 'my', 'th', 'tr', 'vi', 'zh'
]);

const TWO_FORM_LANGUAGES = new Set([
  'af', 'am', 'bg', 'bn', 'ca', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'fi', 'fo', 'gl', 'gu', 'he', 'hi', 'hu', 'hy', 'it', 'kn', 'ml', 'mn',
  'mr', 'nb', 'ne', 'nl', 'nn', 'no', 'om', 'pa', 'pt', 'sq', 'sv', 'sw', 'ta',
  'te', 'ti', 'ur', 'zu'
]);

function pluralFormsHeader(languageCode: string, requiredForms: number): string {
  const normalized = languageCode.toLowerCase().replace('_', '-');
  const base = normalized.split('-')[0];
  let rule: string | undefined;

  if (ONE_FORM_LANGUAGES.has(base)) rule = 'nplurals=1; plural=0;';
  else if (base === 'fr' || normalized === 'pt-br') rule = 'nplurals=2; plural=(n > 1);';
  else if (base === 'is') rule = 'nplurals=2; plural=(n%10!=1 || n%100==11);';
  else if (PLURAL_FORM_RULES[base]) rule = PLURAL_FORM_RULES[base];
  else if (TWO_FORM_LANGUAGES.has(base)) rule = 'nplurals=2; plural=(n != 1);';

  if (!rule) {
    throw new Error(
      `Cannot create plural PO file for unsupported locale '${languageCode}'. ` +
      'Create the target file with a valid Plural-Forms header first.'
    );
  }
  if (pluralFormCount(rule) < requiredForms) {
    throw new Error(
      `Plural metadata for locale '${languageCode}' contains ${requiredForms} forms, ` +
      `but its Plural-Forms rule supports ${pluralFormCount(rule)}.`
    );
  }

  return rule;
}

function pluralFormCount(header: string): number {
  return Number(header.match(/nplurals=(\d+)/)?.[1] ?? 2);
}

function commentsFromMetadata(metadata: TranslationWithMetadata['metadata']): PoEntry['comments'] {
  const references = Array.from(new Set(metadata?.source_references ?? []));
  const flags = Array.from(new Set(metadata?.po_flags ?? []));
  const comments = {
    ...(references.length > 0 && { reference: references.join('\n') }),
    ...(metadata?.translator_comments && { extracted: metadata.translator_comments }),
    ...(flags.length > 0 && { flag: flags.join(', ') })
  };

  return Object.keys(comments).length > 0 ? comments : undefined;
}

function referencesByKey(
  metadataByKey: Map<string, TranslationWithMetadata['metadata']>
): Record<string, string[]> {
  const references: Record<string, string[]> = {};
  for (const [key, metadata] of metadataByKey) {
    const refs = metadata?.source_references;
    if (refs?.length) {
      references[key] = refs;
    }
  }
  return references;
}

/**
 * Updates a .po file with new translations
 */
export async function updatePoFile(
  filePath: string,
  translations: Record<string, unknown> | TranslationWithMetadata[],
  languageCode: string = 'en',
  sourceFilePath: string | null = null,
  sourceLanguage?: string
): Promise<{ created: boolean; updatedKeys: string[] }> {
  let created = false;
  const fileAlreadyExists = await fileExists(filePath);

  // Build keyMappings for PO versioning (old key → new key)
  const keyMappings: Record<string, string> = {};
  const metadataByKey = new Map<string, TranslationWithMetadata['metadata']>();
  let stringTranslations: Record<string, string>;

  if (Array.isArray(translations)) {
    // Sync mode: array of SyncTranslation objects with metadata
    stringTranslations = {};
    for (const item of translations) {
      const value = typeof item.value === 'string' ? item.value : String(item.value);
      stringTranslations[item.key] = value;
      metadataByKey.set(item.key, item.metadata);

      for (const oldValue of item.old_values ?? []) {
        keyMappings[oldValue.key] = item.key;
      }
    }
  } else {
    // Regular mode: Record<string, unknown>
    stringTranslations = Object.fromEntries(
      Object.entries(translations).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : String(value)
      ])
    );
  }

  const hasKeyMappings = Object.keys(keyMappings).length > 0;
  let updatedKeys: string[] = [];

  if (fileAlreadyExists) {
    const originalContent = await readFile(filePath, 'utf-8');

    // Get source content if available for proper msgid_plural lookup
    let sourceContent: string | undefined;
    if (sourceFilePath && await fileExists(sourceFilePath)) {
      sourceContent = await readFile(sourceFilePath, 'utf-8');
    }

    const updatedContent = surgicalUpdatePoFile(originalContent, stringTranslations, {
      sourceLanguage,
      targetLanguage: languageCode,
      sourceContent,
      keyMappings: hasKeyMappings ? keyMappings : undefined,
      references: referencesByKey(metadataByKey)
    });

    if (updatedContent !== originalContent) {
      updatedKeys = Object.keys(stringTranslations);
      await writeFile(filePath, updatedContent, 'utf-8');
    }
  } else {
    created = true;
    updatedKeys = Object.keys(stringTranslations);

    if (sourceFilePath && await fileExists(sourceFilePath)) {
      const sourceContent = await readFile(sourceFilePath, 'utf-8');
      const updatedContent = surgicalUpdatePoFile(sourceContent, stringTranslations, {
        sourceLanguage,
        targetLanguage: languageCode,
        sourceContent,
        keyMappings: hasKeyMappings ? keyMappings : undefined
      });

      await writeFile(filePath, updatedContent, 'utf-8');
    } else {
      // Create minimal .po file structure
      const hasPluralMetadata = Array.from(metadataByKey.values())
        .some(metadata => metadata?.po_plural);
      const requiredPluralForms = Math.max(
        1,
        ...Array.from(metadataByKey.values())
          .filter(metadata => metadata?.po_plural)
          .map(metadata => (metadata?.plural_index ?? 0) + 1)
      );
      const pluralHeader = hasPluralMetadata
        ? pluralFormsHeader(languageCode, requiredPluralForms)
        : undefined;
      const nplurals = pluralHeader ? pluralFormCount(pluralHeader) : 1;
      const entriesByKey = new Map<string, PoEntry>();
      const pluralEntryKeys = new Set<string>();

      for (const [key, value] of Object.entries(stringTranslations)) {
        const metadata = metadataByKey.get(key);
        const isPlural = metadata?.po_plural === true;
        const baseKey = isPlural ? key.replace(PLURAL_SUFFIX_REGEX, '') : key;
        const { msgid: parsedMsgid, context } = parseUniqueKey(baseKey);
        const msgid = metadata?.msgid || parsedMsgid;

        if (!isPlural) {
          entriesByKey.set(baseKey, {
            msgid,
            msgstr: [value],
            msgctxt: context,
            comments: commentsFromMetadata(metadata)
          });
          continue;
        }

        pluralEntryKeys.add(baseKey);
        const pluralIndex = metadata?.plural_index ?? Number(key.match(PLURAL_SUFFIX_REGEX)?.[0].match(/\d+$/)?.[0] ?? 0);
        if (pluralIndex >= nplurals) {
          throw new Error(
            `Plural form index ${pluralIndex} for '${msgid}' exceeds the ${nplurals} forms ` +
            `supported by locale '${languageCode}'.`
          );
        }
        const existing = entriesByKey.get(baseKey);
        const entry = existing ?? {
          msgid,
          msgstr: Array(nplurals).fill(''),
          msgctxt: context,
          msgid_plural: metadata?.msgid_plural,
          comments: commentsFromMetadata(metadata)
        };
        entry.msgstr[pluralIndex] = value;
        if (metadata?.msgid_plural) {
          entry.msgid_plural = metadata.msgid_plural;
        }
        entry.comments ||= commentsFromMetadata(metadata);
        entriesByKey.set(baseKey, entry);
      }

      const entries = Array.from(entriesByKey.values());
      for (const key of pluralEntryKeys) {
        const entry = entriesByKey.get(key);
        if (!entry?.msgid_plural) {
          throw new Error(
            `Cannot create plural PO entry for '${entry?.msgid ?? key}' without msgid_plural metadata.`
          );
        }
      }
      const hasPlurals = entries.some(entry => entry.msgid_plural);

      const headers = {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Language': languageCode,
        ...(hasPlurals && pluralHeader && { 'Plural-Forms': pluralHeader })
      };

      const poContent = createPoFile(entries, headers);
      await writeFile(filePath, poContent, 'utf-8');
    }
  }

  return { created, updatedKeys };
}

/**
 * Removes keys from a .po file
 */
export async function deleteKeysFromPoFile(
  filePath: string,
  keysToDelete: string[]
): Promise<void> {
  if (!await fileExists(filePath)) {
    return;
  }

  const originalContent = await readFile(filePath, 'utf-8');
  const parsed = parsePoFile(originalContent);
  const deleteSet = new Set(keysToDelete);

  const filteredEntries = parsed.entries.filter(entry => {
    const uniqueKey = entry.msgctxt
      ? `${entry.msgctxt}|${entry.msgid}`
      : entry.msgid;
    return !deleteSet.has(uniqueKey);
  });

  const updatedContent = createPoFile(filteredEntries, parsed.headers);
  await writeFile(filePath, updatedContent, 'utf-8');
}
