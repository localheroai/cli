import { describe, expect, it } from '@jest/globals';
import yaml from 'yaml';
import {
  MarkdownDocumentAdapter,
  MarkdownExtractOptions
} from '../../src/document-formats/markdown.js';
import {
  DocumentFormatError,
  DocumentTranslation
} from '../../src/document-formats/types.js';
import type { MarkdownExtraction } from '../../src/document-formats/markdown.js';

const adapter = new MarkdownDocumentAdapter();

function extract(source: string, options: MarkdownExtractOptions = {}): MarkdownExtraction {
  return adapter.extract(source, options);
}

function identityTranslations(extraction: MarkdownExtraction): DocumentTranslation[] {
  return extraction.manifest.units.map(unit => ({ id: unit.id, text: unit.source }));
}

function translationsWith(
  extraction: MarkdownExtraction,
  replacements: Record<string, string>
): DocumentTranslation[] {
  return extraction.manifest.units.map(unit => ({
    id: unit.id,
    text: replacements[unit.id] ?? unit.source
  }));
}

function errorCode(callback: () => unknown): string | undefined {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof DocumentFormatError ? error.code : undefined;
  }
}

describe('MarkdownDocumentAdapter', () => {
  it('extracts ordered semantic units and round-trips byte-identically', () => {
    const source = [
      '---',
      'title: "A guide: #1"',
      'description: A useful guide',
      'author: "Arvid"',
      '---',
      '# Getting started',
      '',
      'Read the **short guide** and visit [the docs](https://example.com/docs?q=1 "Docs").',
      '',
      '- First item',
      '- Second item',
      '',
      '| Feature | Status |',
      '| --- | --- |',
      '| Markdown | Ready |',
      ''
    ].join('\n');

    const extraction = extract(source, {
      translateFrontmatterFields: ['title', 'description']
    });

    expect(extraction.manifest).toMatchObject({
      format: 'markdown',
      formatVersion: 1
    });
    expect(extraction.manifest.units.map(unit => unit.role)).toEqual([
      'frontmatter',
      'frontmatter',
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'table-cell',
      'table-cell',
      'table-cell',
      'table-cell'
    ]);
    expect(extraction.manifest.units[2].context.headingPath).toEqual([]);
    expect(extraction.manifest.units[3].context.headingPath).toEqual(['Getting started']);
    expect(JSON.stringify(extraction.manifest)).not.toContain('https://example.com');
    expect(extraction.manifest.units.every(unit => !('range' in unit) && !('original' in unit))).toBe(true);
    expect(adapter.apply(source, extraction, identityTranslations(extraction))).toBe(source);
  });

  it('changes selected prose while preserving Markdown syntax and opaque regions', () => {
    const source = [
      '# Guide with `npm test`',
      '',
      'Use **carefully** with [the docs](https://example.com/a_(b) "A title"), ![logo](./logo.png), and <kbd>Enter</kbd>.',
      '',
      '> Two lines of',
      '> quoted prose.',
      '',
      '````md',
      '```js',
      'const untranslated = "Hello";',
      '```',
      '````',
      '',
      '~~~txt',
      'also untranslated',
      '~~~',
      ''
    ].join('\n');
    const extraction = extract(source);
    const heading = extraction.manifest.units.find(unit => unit.role === 'heading')!;
    const prose = extraction.manifest.units.find(unit =>
      unit.role === 'paragraph' && unit.source.includes('carefully')
    )!;
    const quote = extraction.manifest.units.find(unit => unit.source.includes('quoted prose'))!;

    const output = adapter.apply(source, extraction, translationsWith(extraction, {
      [heading.id]: heading.source.replace('Guide with', 'Guide avec'),
      [prose.id]: prose.source
        .replace('Use', 'Utilisez')
        .replace('carefully', 'avec prudence')
        .replace('the docs', 'la documentation')
        .replace('and', 'et')
        .replace('Enter', 'Entrée'),
      [quote.id]: quote.source.replace('Two lines of', 'Deux lignes de').replace('quoted prose', 'texte cité')
    }));

    expect(output).toContain('# Guide avec `npm test`');
    expect(output).toContain('**avec prudence**');
    expect(output).toContain('[la documentation](https://example.com/a_(b) "A title")');
    expect(output).toContain('![logo](./logo.png)');
    expect(output).toContain('<kbd>Entrée</kbd>');
    expect(output).toContain('> Deux lignes de\n> texte cité.');
    expect(output).toContain('````md\n```js\nconst untranslated = "Hello";\n```\n````');
    expect(output).toContain('~~~txt\nalso untranslated\n~~~');
  });

  it('translates only explicitly configured top-level frontmatter strings', () => {
    const source = [
      '---',
      'title: "Hello: #world"',
      "description: 'A quoted value'",
      'locale: en',
      'draft: false',
      '---',
      '# Hello',
      ''
    ].join('\n');
    const extraction = extract(source, { translateFrontmatterFields: ['title', 'description'] });
    const title = extraction.manifest.units.find(unit => unit.context.frontmatterField === 'title')!;
    const description = extraction.manifest.units.find(unit =>
      unit.context.frontmatterField === 'description'
    )!;

    const output = adapter.apply(source, extraction, translationsWith(extraction, {
      [title.id]: 'Bonjour : #monde',
      [description.id]: "Une valeur avec l'apostrophe"
    }));
    const parsed = yaml.parse(output.split('---')[1]) as Record<string, unknown>;

    expect(output).toContain('title: "Bonjour : #monde"');
    expect(output).toContain("description: 'Une valeur avec l''apostrophe'");
    expect(output).toContain('locale: en\ndraft: false');
    expect(parsed).toMatchObject({
      title: 'Bonjour : #monde',
      description: "Une valeur avec l'apostrophe",
      locale: 'en',
      draft: false
    });
  });

  it('does not infer locale or translate frontmatter without an allowlist', () => {
    const source = '---\ntitle: Hello\nlocale: en\n---\n# Hello\n';
    const extraction = extract(source);

    expect(extraction.manifest.units.filter(unit => unit.role === 'frontmatter')).toEqual([]);
    expect(extraction.manifest).not.toHaveProperty('locale');
  });

  it('rejects configured non-string and block-scalar frontmatter values', () => {
    expect(errorCode(() => extract('---\ndraft: false\n---\n', {
      translateFrontmatterFields: ['draft']
    }))).toBe('unsupported_frontmatter_value');

    const block = '---\ndescription: |-\n  First line\n  Second line\n---\n';
    expect(errorCode(() => extract(block, {
      translateFrontmatterFields: ['description']
    }))).toBe('unsupported_frontmatter_style');
    expect(() => extract(block)).not.toThrow();
  });

  it('rejects multiline frontmatter translations instead of emitting ambiguous YAML', () => {
    const source = '---\ndescription: "One line"\n---\n';
    const extraction = extract(source, { translateFrontmatterFields: ['description'] });
    const description = extraction.manifest.units[0];

    expect(errorCode(() => adapter.apply(source, extraction, [{
      id: description.id,
      text: 'First line\nSecond line'
    }]))).toBe('unsupported_frontmatter_translation');
  });

  it('rejects stale sources before applying translations', () => {
    const source = '# Hello\n';
    const extraction = extract(source);

    expect(errorCode(() => adapter.apply(
      '# Hello!\n',
      extraction,
      identityTranslations(extraction)
    ))).toBe('stale_source');
  });

  it('rejects missing, duplicate, and unknown translation IDs', () => {
    const source = '# Hello\n\nWorld.\n';
    const extraction = extract(source);
    const translations = identityTranslations(extraction);

    expect(errorCode(() => adapter.apply(source, extraction, translations.slice(1))))
      .toBe('missing_translation');
    expect(errorCode(() => adapter.apply(source, extraction, [...translations, translations[0]])))
      .toBe('duplicate_translation');
    expect(errorCode(() => adapter.apply(source, extraction, [
      ...translations,
      { id: 'not-a-unit', text: 'No' }
    ]))).toBe('unknown_translation');
  });

  it('rejects lost, duplicated, changed, and injected placeholders', () => {
    const source = 'Use `npm test` and [the docs](https://example.com).\n';
    const extraction = extract(source);
    const unit = extraction.manifest.units[0];
    const token = unit.placeholders[0].token;

    for (const text of [
      unit.source.replace(token, ''),
      `${unit.source}${token}`,
      unit.source.replace(token, token.slice(0, -1)),
      `${unit.source} __LOCALHERO_MD_UNKNOWN__`
    ]) {
      expect(() => adapter.apply(source, extraction, [{ id: unit.id, text }])).toThrow(DocumentFormatError);
    }
  });

  it('allows protected inline constructs to be reordered without changing them', () => {
    const source = 'Run `first` before `second`.\n';
    const extraction = extract(source);
    const unit = extraction.manifest.units[0];
    const [first, second] = unit.placeholders.map(placeholder => placeholder.token);
    const translated = unit.source
      .replace(first, '__SWAP__')
      .replace(second, first)
      .replace('__SWAP__', second);

    expect(adapter.apply(source, extraction, [{ id: unit.id, text: translated }]))
      .toBe('Run `second` before `first`.\n');
  });

  it('preserves BOM, CRLF, Unicode offsets, and the final-newline shape', () => {
    const source = '\uFEFF# 👋 Hello\r\n\r\nA café paragraph.\r\n';
    const extraction = extract(source);
    const paragraph = extraction.manifest.units.find(unit => unit.role === 'paragraph')!;
    const output = adapter.apply(source, extraction, translationsWith(extraction, {
      [paragraph.id]: 'Un paragraphe café.'
    }));

    expect(output).toBe('\uFEFF# 👋 Hello\r\n\r\nUn paragraphe café.\r\n');
    expect(adapter.apply(source, extraction, identityTranslations(extraction))).toBe(source);
  });

  it('preserves ordered-list, task-list, and table delimiters', () => {
    const source = [
      '1. First step',
      '2. [x] Finished step',
      '',
      '| Name | State |',
      '| :--- | ---: |',
      '| Build | Ready |'
    ].join('\n');
    const extraction = extract(source);
    const replacements = Object.fromEntries(extraction.manifest.units.map(unit => [
      unit.id,
      unit.source
        .replace('First step', 'Première étape')
        .replace('Finished step', 'Étape terminée')
        .replace('Name', 'Nom')
        .replace('State', 'État')
        .replace('Build', 'Version')
        .replace('Ready', 'Prêt')
    ]));

    expect(adapter.apply(source, extraction, translationsWith(extraction, replacements))).toBe([
      '1. Première étape',
      '2. [x] Étape terminée',
      '',
      '| Nom | État |',
      '| :--- | ---: |',
      '| Version | Prêt |'
    ].join('\n'));
  });

  it('does not add a final newline when the source has none', () => {
    const source = '# Hello\n\nNo final newline';
    const extraction = extract(source);
    const paragraph = extraction.manifest.units.find(unit => unit.role === 'paragraph')!;

    expect(adapter.apply(source, extraction, translationsWith(extraction, {
      [paragraph.id]: 'Toujours sans saut final'
    }))).toBe('# Hello\n\nToujours sans saut final');
  });

  it('tokenizes adjacent placeholders separately when no text sits between them', () => {
    const source = 'Status **`check`** and **bold** here.\n';
    const extraction = extract(source);
    const unit = extraction.manifest.units[0];

    expect(unit.placeholders.map(placeholder => placeholder.kind)).toEqual([
      'strong-open',
      'inlineCode',
      'strong-close',
      'strong-open',
      'strong-close'
    ]);
    for (const placeholder of unit.placeholders) {
      expect(unit.source).toContain(placeholder.token);
    }
    expect(adapter.apply(source, extraction, identityTranslations(extraction))).toBe(source);
  });

  it('keeps image paths, autolinks, reference destinations, and raw HTML opaque', () => {
    const source = [
      'See <https://example.com>, [reference][docs], and ![logo](./logo.svg).',
      '',
      '<section data-name="hello">',
      'Raw HTML body',
      '</section>',
      '',
      '[docs]: https://example.com/reference "Reference"',
      ''
    ].join('\n');
    const extraction = extract(source);
    const prose = extraction.manifest.units[0];
    const output = adapter.apply(source, extraction, translationsWith(extraction, {
      [prose.id]: prose.source.replace('See', 'Voir').replace('reference', 'référence')
    }));

    expect(output).toContain('<https://example.com>');
    expect(output).toContain('[référence][docs]');
    expect(output).toContain('![logo](./logo.svg)');
    expect(output).toContain('<section data-name="hello">\nRaw HTML body\n</section>');
    expect(output).toContain('[docs]: https://example.com/reference "Reference"');
  });
});
