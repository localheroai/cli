import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import { updateTranslationFile } from '../../src/utils/translation-updater/index.js';

// Property/fuzz coverage for the two YAML-writer invariants whose input space
// is too large to enumerate by example (the specific bug shapes from
// 0.0.53/0.0.54 are pinned in translation-updater.test.js):
//
//   P1 — any supported value round-trips: write {k: v}, re-parse, get v back.
//        Fuzzes the full scalar shape space (unicode, quotes, spaces, numbers,
//        booleans, arrays, interpolation) where examples miss encoding edges.
//   P2 — updating one leaf never alters any untouched key. Fuzzes the nested
//        STRUCTURE (depth, breadth, neighbours) where adjacent-data loss hides.
//
// Oracle is SEMANTIC round-trip (re-parsed values), not byte equality — the
// writer may legitimately re-quote a new value. Generators are scoped to the
// SUPPORTED shapes; block literals, anchors, and multi-line plain scalars are
// out of scope by design and intentionally not generated.

const NUM_RUNS = 200;

const leafValue = fc.oneof(
  fc.string(),
  fc.constantFrom('', '%{count} items', 'it\'s "quoted"', '  padded  ', 'café ☕'),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(0, -0.5, 3.14),
  fc.boolean(),
  fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 })
);

const keySegment = fc
  .string({ minLength: 1, maxLength: 6 })
  .map((s) => s.replace(/[^a-zA-Z0-9_]/g, 'x'))
  .filter((s) => s.length > 0);

function nestedObject(depth) {
  if (depth <= 0) return leafValue;
  return fc.dictionary(keySegment, fc.oneof(leafValue, nestedObject(depth - 1)), {
    minKeys: 1,
    maxKeys: 4
  });
}

function flattenLeaves(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenLeaves(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

async function withTempFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-fuzz-'));
  try {
    return await fn(path.join(dir, 'en.yml'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('translation-updater (property/fuzz)', () => {
  it('P1: a written value round-trips through re-parse for any supported shape', async () => {
    await fc.assert(
      fc.asyncProperty(keySegment, leafValue, async (key, value) => {
        await withTempFile(async (filePath) => {
          fs.writeFileSync(filePath, 'en:\n  seed: keep\n');
          await updateTranslationFile(filePath, { [key]: value }, 'en');
          const parsed = yaml.parse(fs.readFileSync(filePath, 'utf8')).en;
          expect(parsed[key]).toEqual(value);
          expect(parsed.seed).toBe('keep');
        });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('P2: updating one leaf never alters the value of any untouched key', async () => {
    await fc.assert(
      fc.asyncProperty(nestedObject(2), leafValue, async (tree, newValue) => {
        const leaves = flattenLeaves(tree);
        const keys = Object.keys(leaves);
        fc.pre(keys.length >= 2);

        await withTempFile(async (filePath) => {
          const doc = new yaml.Document();
          doc.contents = doc.createNode({ en: tree });
          fs.writeFileSync(filePath, doc.toString());

          const before = yaml.parse(fs.readFileSync(filePath, 'utf8')).en;
          const target = keys[0];
          await updateTranslationFile(filePath, { [target]: newValue }, 'en');
          const after = yaml.parse(fs.readFileSync(filePath, 'utf8')).en;

          for (const key of keys.slice(1)) {
            const segments = key.split('.');
            const beforeVal = segments.reduce((o, s) => o?.[s], before);
            const afterVal = segments.reduce((o, s) => o?.[s], after);
            expect(afterVal).toEqual(beforeVal);
          }
        });
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
