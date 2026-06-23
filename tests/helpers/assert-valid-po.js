/**
 * Dependency-free structural assertions for generated .po content.
 *
 * These run everywhere (no gettext/msgfmt required) and exist to catch the
 * class of bugs that substring assertions miss: empty msgids, duplicate
 * definitions, and malformed plural entries. The empty-msgid and duplicate
 * checks work on raw text on purpose, the PO parser collapses/skips these, so
 * a corrupt `msgid ""` paired with a real msgstr would otherwise be invisible.
 */

import { parsePoFile } from '../../src/utils/po-utils.js';

/**
 * Split .po content into raw entry blocks (keeping comment lines).
 * Block 0 is the header (the legitimate `msgid ""`).
 */
function rawEntries(content) {
  return content
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && /(^|\n)msgid /.test(block));
}

function msgidOf(block) {
  const match = block.match(/(^|\n)msgid "((?:[^"\\]|\\.)*)"/);
  return match ? match[2] : null;
}

function msgctxtOf(block) {
  const match = block.match(/(^|\n)msgctxt "((?:[^"\\]|\\.)*)"/);
  return match ? match[2] : null;
}

/**
 * Assert that generated .po content is structurally valid.
 * Returns the parsed file so callers can make further assertions.
 */
export function assertValidPo(content, { allowEmpty = false } = {}) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('assertValidPo: content is empty');
  }

  const blocks = rawEntries(content);
  const seen = new Set();

  blocks.forEach((block, index) => {
    if (index === 0) return; // header is the one legitimate `msgid ""`

    // 1. No non-header entry may have an empty msgid (the corruption bug).
    //    Raw-text check: po.parse silently drops these.
    if (msgidOf(block) === '') {
      throw new Error(`assertValidPo: entry #${index} has an empty msgid:\n${block}`);
    }

    // 2. No duplicate msgid+msgctxt. Raw-text check: po.parse collapses
    //    duplicates (last wins), so a parsed-entry check would never see them.
    const key = `${msgctxtOf(block) ?? ''} ${msgidOf(block)}`;
    if (seen.has(key)) {
      throw new Error(`assertValidPo: duplicate entry (msgctxt+msgid):\n${block}`);
    }
    seen.add(key);
  });

  // 3. The file must re-parse without throwing.
  let parsed;
  try {
    parsed = parsePoFile(content);
  } catch (error) {
    throw new Error(`assertValidPo: content does not parse: ${error.message}`);
  }

  if (!allowEmpty && parsed.entries.length === 0) {
    throw new Error('assertValidPo: no translation entries found');
  }

  // 4. Plural entries must have msgid_plural and at least one msgstr form.
  for (const entry of parsed.entries) {
    if (entry.msgid_plural && (!Array.isArray(entry.msgstr) || entry.msgstr.length === 0)) {
      throw new Error(
        `assertValidPo: plural entry for msgid=${JSON.stringify(entry.msgid)} has no msgstr forms`
      );
    }
  }

  return parsed;
}
