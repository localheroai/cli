import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import yaml from 'yaml';
import {
  DocumentExtraction,
  DocumentFormatAdapter,
  DocumentFormatError,
  DocumentManifest,
  DocumentTranslation,
  DocumentUnit,
  DocumentUnitContext,
  DocumentUnitRole
} from './types.js';

const FORMAT = 'markdown';
const FORMAT_VERSION = 1;
const RESERVED_PLACEHOLDER_PREFIX = '__LOCALHERO_MD_';
const RESERVED_PLACEHOLDER_PATTERN = /__LOCALHERO_MD_U\d{4}_P\d{4}_[0-9A-F]{8}__/g;

export interface MarkdownExtractOptions {
  translateFrontmatterFields?: readonly string[];
}

interface Point {
  offset?: number;
}

interface Position {
  start: Point;
  end: Point;
}

interface SourceRange {
  start: number;
  end: number;
}

interface ProtectedFragment {
  token: string;
  value: string;
}

interface MarkdownPatchPlan {
  unitId: string;
  range: SourceRange;
  original: string;
  protectedFragments: ProtectedFragment[];
  serialization: 'markdown' | 'yaml-scalar';
  yamlScalarType?: string | null;
}

interface MarkdownApplyPlan {
  sourceSha256: string;
  patches: MarkdownPatchPlan[];
}

export type MarkdownExtraction = DocumentExtraction<MarkdownApplyPlan>;

interface MarkdownNode {
  type: string;
  position?: Position;
  children?: MarkdownNode[];
  value?: string;
  depth?: number;
  url?: string;
  title?: string | null;
  identifier?: string;
  label?: string;
  lang?: string | null;
  meta?: string | null;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  align?: Array<string | null>;
}

interface ParsedMarkdown {
  root: MarkdownNode;
  offsetBase: number;
}

interface ProtectedRange extends SourceRange {
  kind: string;
}

interface DraftUnit {
  role: DocumentUnitRole;
  range: SourceRange;
  source: string;
  context: DocumentUnitContext;
  placeholders: Array<{ token: string; kind: string }>;
  protectedFragments: ProtectedFragment[];
  serialization: MarkdownPatchPlan['serialization'];
  yamlScalarType?: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseMarkdown(source: string): ParsedMarkdown {
  const offsetBase = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const root = fromMarkdown(source.slice(offsetBase), {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])]
  }) as MarkdownNode;

  return { root, offsetBase };
}

function nodeRange(node: MarkdownNode, offsetBase: number): SourceRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  return { start: start + offsetBase, end: end + offsetBase };
}

function childContentRange(node: MarkdownNode, offsetBase: number): SourceRange | null {
  const positionedChildren = (node.children ?? [])
    .map(child => nodeRange(child, offsetBase))
    .filter((range): range is SourceRange => range !== null);
  if (positionedChildren.length === 0) return null;
  return {
    start: positionedChildren[0].start,
    end: positionedChildren[positionedChildren.length - 1].end
  };
}

function walk(node: MarkdownNode, visit: (child: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function plainText(node: MarkdownNode): string {
  const values: string[] = [];
  walk(node, child => {
    if ((child.type === 'text' || child.type === 'inlineCode') && child.value) {
      values.push(child.value);
    }
  });
  return values.join('').trim();
}

function collectSemanticNodes(root: MarkdownNode, offsetBase: number): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];

  const collect = (node: MarkdownNode): void => {
    if (node.type === 'heading' || node.type === 'paragraph' || node.type === 'tableCell') {
      if (childContentRange(node, offsetBase)) nodes.push(node);
      return;
    }

    if (node.type === 'code' || node.type === 'html' || node.type === 'yaml') return;
    for (const child of node.children ?? []) collect(child);
  };

  collect(root);
  return nodes.sort((left, right) => {
    const leftStart = nodeRange(left, offsetBase)?.start ?? 0;
    const rightStart = nodeRange(right, offsetBase)?.start ?? 0;
    return leftStart - rightStart;
  });
}

function roleForNode(node: MarkdownNode): DocumentUnitRole {
  if (node.type === 'heading') return 'heading';
  if (node.type === 'tableCell') return 'table-cell';
  return 'paragraph';
}

function addWholeNodeRange(
  ranges: ProtectedRange[],
  node: MarkdownNode,
  offsetBase: number,
  unitRange: SourceRange,
  kind: string
): void {
  const range = nodeRange(node, offsetBase);
  if (!range || range.start < unitRange.start || range.end > unitRange.end) return;
  ranges.push({ ...range, kind });
}

function addWrapperRanges(
  ranges: ProtectedRange[],
  node: MarkdownNode,
  offsetBase: number,
  unitRange: SourceRange,
  kind: string
): void {
  const range = nodeRange(node, offsetBase);
  const contents = childContentRange(node, offsetBase);
  if (!range || !contents || range.start < unitRange.start || range.end > unitRange.end) return;
  if (range.start < contents.start) {
    ranges.push({ start: range.start, end: contents.start, kind: `${kind}-open` });
  }
  if (contents.end < range.end) {
    ranges.push({ start: contents.end, end: range.end, kind: `${kind}-close` });
  }
}

function isAutolink(node: MarkdownNode, source: string, offsetBase: number): boolean {
  if (node.type !== 'link' || !node.url) return false;
  const range = nodeRange(node, offsetBase);
  if (!range) return false;
  const raw = source.slice(range.start, range.end);
  const anchor = plainText(node);
  return anchor === node.url && (raw === node.url || raw === `<${node.url}>`);
}

function normalizeProtectedRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.start - right.start || right.end - left.end
  );
  const normalized: ProtectedRange[] = [];

  for (const range of sorted) {
    if (range.start === range.end) continue;
    const previous = normalized[normalized.length - 1];
    if (!previous || range.start >= previous.end) {
      normalized.push(range);
      continue;
    }
    if (range.end <= previous.end) continue;
    throw new DocumentFormatError(
      'overlapping_protected_ranges',
      'Markdown parser produced partially overlapping protected ranges.'
    );
  }

  return normalized;
}

function protectedRangesForNode(
  node: MarkdownNode,
  source: string,
  offsetBase: number,
  unitRange: SourceRange
): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const atomicTypes = new Set([
    'inlineCode',
    'html',
    'image',
    'imageReference',
    'footnoteReference',
    'break'
  ]);
  const wrapperTypes = new Set(['emphasis', 'strong', 'delete', 'linkReference']);

  walk(node, child => {
    if (atomicTypes.has(child.type)) {
      addWholeNodeRange(ranges, child, offsetBase, unitRange, child.type);
      return;
    }
    if (child.type === 'link') {
      if (isAutolink(child, source, offsetBase)) {
        addWholeNodeRange(ranges, child, offsetBase, unitRange, 'autolink');
      } else {
        addWrapperRanges(ranges, child, offsetBase, unitRange, 'link');
      }
      return;
    }
    if (wrapperTypes.has(child.type)) {
      addWrapperRanges(ranges, child, offsetBase, unitRange, child.type);
    }
  });

  const original = source.slice(unitRange.start, unitRange.end);
  const newlinePattern = /(?:\r\n|\r|\n)[ \t]*(?:(?:>[ \t]?)+)?/g;
  for (const match of original.matchAll(newlinePattern)) {
    const relativeStart = match.index;
    ranges.push({
      start: unitRange.start + relativeStart,
      end: unitRange.start + relativeStart + match[0].length,
      kind: 'line-break'
    });
  }

  return normalizeProtectedRanges(ranges);
}

function makePlaceholder(unitIndex: number, fragmentIndex: number, value: string): string {
  const digest = sha256(value).slice(0, 8).toUpperCase();
  return `${RESERVED_PLACEHOLDER_PREFIX}U${String(unitIndex + 1).padStart(4, '0')}_P${String(fragmentIndex + 1).padStart(4, '0')}_${digest}__`;
}

function templateWithPlaceholders(
  source: string,
  unitRange: SourceRange,
  protectedRanges: ProtectedRange[],
  unitIndex: number
): {
  template: string;
  placeholders: Array<{ token: string; kind: string }>;
  fragments: ProtectedFragment[];
} {
  let template = source.slice(unitRange.start, unitRange.end);
  const placeholders: Array<{ token: string; kind: string }> = [];
  const fragments: ProtectedFragment[] = [];

  protectedRanges.forEach((range, fragmentIndex) => {
    const value = source.slice(range.start, range.end);
    const token = makePlaceholder(unitIndex, fragmentIndex, value);
    placeholders.push({ token, kind: range.kind });
    fragments.push({ token, value });
  });

  for (let index = protectedRanges.length - 1; index >= 0; index--) {
    const range = protectedRanges[index];
    const relativeStart = range.start - unitRange.start;
    const relativeEnd = range.end - unitRange.start;
    template = template.slice(0, relativeStart) + placeholders[index].token + template.slice(relativeEnd);
  }

  return { template, placeholders, fragments };
}

function hasTranslatableText(template: string): boolean {
  const withoutPlaceholders = template.replace(RESERVED_PLACEHOLDER_PATTERN, '');
  return /[\p{L}\p{N}]/u.test(withoutPlaceholders);
}

function yamlInnerRange(source: string, range: SourceRange): SourceRange {
  const raw = source.slice(range.start, range.end);
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/.exec(raw);
  const closing = /(?:\r\n|\n|\r)---[ \t]*$/.exec(raw);
  if (!opening || !closing || closing.index < opening[0].length) {
    throw new DocumentFormatError('invalid_frontmatter', 'Could not locate YAML frontmatter fences.');
  }
  return {
    start: range.start + opening[0].length,
    end: range.start + closing.index
  };
}

function rangeFromYamlNode(node: unknown): [number, number, number] | null {
  if (!node || typeof node !== 'object' || !('range' in node)) return null;
  const range = (node as { range?: [number, number, number] }).range;
  return Array.isArray(range) && range.length === 3 ? range : null;
}

function frontmatterDrafts(
  source: string,
  parsed: ParsedMarkdown,
  fields: readonly string[]
): DraftUnit[] {
  if (fields.length === 0) return [];
  const yamlNode = parsed.root.children?.find(child => child.type === 'yaml');
  if (!yamlNode) return [];
  const frontmatterRange = nodeRange(yamlNode, parsed.offsetBase);
  if (!frontmatterRange) return [];

  const innerRange = yamlInnerRange(source, frontmatterRange);
  const inner = source.slice(innerRange.start, innerRange.end);
  const document = yaml.parseDocument(inner, { keepSourceTokens: true, strict: true });
  if (document.errors.length > 0) {
    throw new DocumentFormatError(
      'invalid_frontmatter',
      `YAML frontmatter could not be parsed: ${document.errors[0].message}`
    );
  }
  if (!document.contents || !yaml.isMap(document.contents)) {
    throw new DocumentFormatError('invalid_frontmatter', 'YAML frontmatter must be a mapping.');
  }

  const drafts: DraftUnit[] = [];
  for (const field of new Set(fields)) {
    const valueNode = document.get(field, true);
    if (valueNode === undefined) continue;
    if (!yaml.isScalar(valueNode) || typeof valueNode.value !== 'string') {
      throw new DocumentFormatError(
        'unsupported_frontmatter_value',
        `Configured frontmatter field "${field}" must be a string scalar.`
      );
    }
    if (valueNode.tag) {
      throw new DocumentFormatError(
        'unsupported_frontmatter_value',
        `Configured frontmatter field "${field}" may not use a YAML tag.`
      );
    }
    if (valueNode.type === 'BLOCK_FOLDED' || valueNode.type === 'BLOCK_LITERAL') {
      throw new DocumentFormatError(
        'unsupported_frontmatter_style',
        `Configured frontmatter field "${field}" uses a block scalar, which is not supported yet.`
      );
    }
    if (valueNode.value.includes('\n') || valueNode.value.includes('\r')) {
      throw new DocumentFormatError(
        'unsupported_frontmatter_style',
        `Configured frontmatter field "${field}" contains a multiline value, which is not supported yet.`
      );
    }
    const scalarRange = rangeFromYamlNode(valueNode);
    if (!scalarRange) {
      throw new DocumentFormatError(
        'invalid_frontmatter',
        `Configured frontmatter field "${field}" has no source range.`
      );
    }
    const absoluteRange = {
      start: innerRange.start + scalarRange[0],
      end: innerRange.start + scalarRange[1]
    };
    drafts.push({
      role: 'frontmatter',
      range: absoluteRange,
      source: valueNode.value,
      context: { headingPath: [], frontmatterField: field },
      placeholders: [],
      protectedFragments: [],
      serialization: 'yaml-scalar',
      yamlScalarType: valueNode.type
    });
  }

  return drafts;
}

function markdownDrafts(source: string, parsed: ParsedMarkdown, unitOffset: number): DraftUnit[] {
  const drafts: DraftUnit[] = [];
  const headingStack: Array<{ depth: number; title: string }> = [];

  for (const node of collectSemanticNodes(parsed.root, parsed.offsetBase)) {
    const range = childContentRange(node, parsed.offsetBase);
    if (!range) continue;
    const role = roleForNode(node);
    const ranges = protectedRangesForNode(node, source, parsed.offsetBase, range);
    const templated = templateWithPlaceholders(source, range, ranges, unitOffset + drafts.length);

    if (hasTranslatableText(templated.template)) {
      drafts.push({
        role,
        range,
        source: templated.template,
        context: { headingPath: headingStack.map(heading => heading.title) },
        placeholders: templated.placeholders,
        protectedFragments: templated.fragments,
        serialization: 'markdown'
      });
    }

    if (node.type === 'heading' && node.depth) {
      const title = plainText(node);
      const depth = node.depth;
      while (headingStack.length > 0 && headingStack.at(-1)!.depth >= depth) headingStack.pop();
      headingStack.push({ depth, title });
    }
  }

  return drafts;
}

function serializeYamlScalar(value: string, existingType: string | null | undefined): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new DocumentFormatError(
      'unsupported_frontmatter_translation',
      'Multiline frontmatter translations are not supported yet.'
    );
  }
  const document = new yaml.Document();
  document.contents = document.createNode({}) as yaml.YAMLMap;
  const root = document.contents as yaml.YAMLMap;
  const key = '__localhero_scalar__';

  if (!value.includes('\n') && (existingType === 'QUOTE_SINGLE' || existingType === 'QUOTE_DOUBLE')) {
    const scalar = new yaml.Scalar(value);
    scalar.type = existingType;
    root.set(key, scalar);
  } else {
    root.set(key, document.createNode(value));
  }

  const emitted = document.toString({ indent: 2, lineWidth: 0 });
  const prefix = `${key}: `;
  const prefixIndex = emitted.indexOf(prefix);
  if (prefixIndex < 0) {
    throw new DocumentFormatError('yaml_serialization_failed', 'Could not serialize a frontmatter value.');
  }
  return emitted.slice(prefixIndex + prefix.length).replace(/\n$/, '');
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

function restoreMarkdownTranslation(
  translation: string,
  patch: MarkdownPatchPlan,
  unitId: string
): string {
  const expectedTokens = new Set(patch.protectedFragments.map(fragment => fragment.token));
  const seenTokens = translation.match(RESERVED_PLACEHOLDER_PATTERN) ?? [];
  for (const token of seenTokens) {
    if (!expectedTokens.has(token)) {
      throw new DocumentFormatError(
        'unknown_placeholder',
        `Translation for ${unitId} contains an unknown Localhero placeholder.`,
        unitId
      );
    }
  }
  for (const fragment of patch.protectedFragments) {
    if (countOccurrences(translation, fragment.token) !== 1) {
      throw new DocumentFormatError(
        'invalid_placeholder_count',
        `Translation for ${unitId} must contain placeholder ${fragment.token} exactly once.`,
        unitId
      );
    }
  }
  if (/[\r\n]/.test(translation)) {
    throw new DocumentFormatError(
      'unexpected_line_break',
      `Translation for ${unitId} introduced an unprotected line break.`,
      unitId
    );
  }

  let restored = translation;
  for (const fragment of patch.protectedFragments) {
    restored = restored.replace(fragment.token, fragment.value);
  }
  return restored;
}

function structuralSignature(source: string): { shape: string[]; protectedValues: string[] } {
  const { root } = parseMarkdown(source);
  const shape: string[] = [];
  const protectedValues: string[] = [];
  walk(root, node => {
    if (node.type === 'root' || node.type === 'text' || node.type === 'yaml') return;
    const properties: Record<string, unknown> = { type: node.type };
    if (node.depth !== undefined) properties.depth = node.depth;
    if (node.lang !== undefined) properties.lang = node.lang;
    if (node.meta !== undefined) properties.meta = node.meta;
    if (node.ordered !== undefined) properties.ordered = node.ordered;
    if (node.start !== undefined) properties.start = node.start;
    if (node.checked !== undefined) properties.checked = node.checked;
    if (node.align !== undefined) properties.align = node.align;
    shape.push(JSON.stringify(properties));

    if (
      node.value !== undefined ||
      node.url !== undefined ||
      node.title !== undefined ||
      node.identifier !== undefined ||
      node.label !== undefined
    ) {
      protectedValues.push(JSON.stringify({
        type: node.type,
        value: node.type === 'code' || node.type === 'inlineCode' || node.type === 'html'
          ? node.value
          : undefined,
        url: node.url,
        title: node.title,
        identifier: node.identifier,
        label: node.label
      }));
    }
  });
  return { shape, protectedValues: protectedValues.sort() };
}

function assertSameStructure(source: string, output: string): void {
  const before = structuralSignature(source);
  const after = structuralSignature(output);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new DocumentFormatError(
      'markdown_structure_changed',
      'Translated Markdown changed protected document structure.'
    );
  }
}

function assertNonOverlappingPatches(patches: readonly MarkdownPatchPlan[]): void {
  const sorted = [...patches].sort((left, right) => left.range.start - right.range.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].range.start < sorted[index - 1].range.end) {
      throw new DocumentFormatError('overlapping_patches', 'Document apply plan contains overlapping patches.');
    }
  }
}

export class MarkdownDocumentAdapter implements DocumentFormatAdapter<MarkdownExtractOptions, MarkdownApplyPlan> {
  readonly format = FORMAT;
  readonly version = FORMAT_VERSION;

  extract(source: string, options: MarkdownExtractOptions = {}): MarkdownExtraction {
    if (source.includes(RESERVED_PLACEHOLDER_PREFIX)) {
      throw new DocumentFormatError(
        'reserved_placeholder_collision',
        `Source contains the reserved placeholder prefix ${RESERVED_PLACEHOLDER_PREFIX}.`
      );
    }

    const parsed = parseMarkdown(source);
    const frontmatter = frontmatterDrafts(
      source,
      parsed,
      options.translateFrontmatterFields ?? []
    );
    const markdown = markdownDrafts(source, parsed, frontmatter.length);
    const drafts = [...frontmatter, ...markdown].sort((left, right) => left.range.start - right.range.start);
    const sourceSha256 = sha256(source);

    const units: DocumentUnit[] = [];
    const patches: MarkdownPatchPlan[] = [];
    drafts.forEach((draft, index) => {
      const id = `u${String(index + 1).padStart(4, '0')}`;
      units.push({
        id,
        role: draft.role,
        source: draft.source,
        sourceHash: sha256(draft.source),
        context: draft.context,
        placeholders: draft.placeholders
      });
      patches.push({
        unitId: id,
        range: draft.range,
        original: source.slice(draft.range.start, draft.range.end),
        protectedFragments: draft.protectedFragments,
        serialization: draft.serialization,
        yamlScalarType: draft.yamlScalarType
      });
    });

    const manifest: DocumentManifest = {
      format: this.format,
      formatVersion: this.version,
      sourceSha256,
      units
    };
    return {
      manifest,
      plan: { sourceSha256, patches }
    };
  }

  apply(
    source: string,
    extraction: MarkdownExtraction,
    translations: readonly DocumentTranslation[]
  ): string {
    const actualSha = sha256(source);
    if (actualSha !== extraction.manifest.sourceSha256 || actualSha !== extraction.plan.sourceSha256) {
      throw new DocumentFormatError('stale_source', 'Source changed after document units were extracted.');
    }
    if (extraction.manifest.format !== this.format || extraction.manifest.formatVersion !== this.version) {
      throw new DocumentFormatError('unsupported_contract', 'Extraction uses an unsupported document contract.');
    }

    assertNonOverlappingPatches(extraction.plan.patches);
    const unitsById = new Map(extraction.manifest.units.map(unit => [unit.id, unit]));
    const patchesById = new Map(extraction.plan.patches.map(patch => [patch.unitId, patch]));
    if (unitsById.size !== extraction.manifest.units.length || patchesById.size !== extraction.plan.patches.length) {
      throw new DocumentFormatError('invalid_extraction', 'Extraction contains duplicate unit IDs.');
    }
    if (unitsById.size !== patchesById.size || [...unitsById.keys()].some(id => !patchesById.has(id))) {
      throw new DocumentFormatError('invalid_extraction', 'Manifest units do not match the private apply plan.');
    }

    const translationsById = new Map<string, string>();
    for (const translation of translations) {
      if (translationsById.has(translation.id)) {
        throw new DocumentFormatError(
          'duplicate_translation',
          `Translation ID ${translation.id} appears more than once.`,
          translation.id
        );
      }
      if (!unitsById.has(translation.id)) {
        throw new DocumentFormatError(
          'unknown_translation',
          `Translation ID ${translation.id} is not part of this extraction.`,
          translation.id
        );
      }
      translationsById.set(translation.id, translation.text);
    }
    for (const unit of extraction.manifest.units) {
      if (!translationsById.has(unit.id)) {
        throw new DocumentFormatError(
          'missing_translation',
          `Translation is missing for unit ${unit.id}.`,
          unit.id
        );
      }
      if (sha256(unit.source) !== unit.sourceHash) {
        throw new DocumentFormatError('invalid_extraction', `Source hash is invalid for unit ${unit.id}.`, unit.id);
      }
    }

    const replacements: Array<{ range: SourceRange; value: string }> = [];
    for (const unit of extraction.manifest.units) {
      const patch = patchesById.get(unit.id)!;
      if (source.slice(patch.range.start, patch.range.end) !== patch.original) {
        throw new DocumentFormatError('stale_source', `Source range changed for unit ${unit.id}.`, unit.id);
      }
      const translated = translationsById.get(unit.id)!;
      if (translated === unit.source) continue;

      const value = patch.serialization === 'yaml-scalar'
        ? serializeYamlScalar(translated, patch.yamlScalarType)
        : restoreMarkdownTranslation(translated, patch, unit.id);
      replacements.push({ range: patch.range, value });
    }

    if (replacements.length === 0) return source;
    let output = source;
    replacements
      .sort((left, right) => right.range.start - left.range.start)
      .forEach(replacement => {
        output = output.slice(0, replacement.range.start) + replacement.value + output.slice(replacement.range.end);
      });

    assertSameStructure(source, output);
    return output;
  }
}

export const markdownDocumentAdapter = new MarkdownDocumentAdapter();
