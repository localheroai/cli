export type DocumentUnitRole = 'heading' | 'paragraph' | 'table-cell' | 'frontmatter';

export interface DocumentPlaceholder {
  token: string;
  kind: string;
}

export interface DocumentUnitContext {
  headingPath: string[];
  frontmatterField?: string;
}

/**
 * The format-neutral payload that may be sent to the Localhero API.
 * Parser offsets and original protected fragments intentionally do not belong here.
 */
export interface DocumentUnit {
  id: string;
  role: DocumentUnitRole;
  source: string;
  sourceHash: string;
  context: DocumentUnitContext;
  placeholders: DocumentPlaceholder[];
}

export interface DocumentManifest {
  format: string;
  formatVersion: number;
  sourceSha256: string;
  units: DocumentUnit[];
}

export interface DocumentTranslation {
  id: string;
  text: string;
}

export interface DocumentExtraction<ApplyPlan> {
  manifest: DocumentManifest;
  plan: ApplyPlan;
}

export interface DocumentFormatAdapter<Options, ApplyPlan> {
  readonly format: string;
  readonly version: number;
  extract(source: string, options: Options): DocumentExtraction<ApplyPlan>;
  apply(
    source: string,
    extraction: DocumentExtraction<ApplyPlan>,
    translations: readonly DocumentTranslation[]
  ): string;
}

export class DocumentFormatError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly unitId?: string
  ) {
    super(message);
    this.name = 'DocumentFormatError';
  }
}
