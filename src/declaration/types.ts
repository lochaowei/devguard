/** A raw override exactly as written in the declaration, with where it was written. */
export interface RawOverride {
  key: string;
  raw: unknown;
  line?: number;
}

export interface DeclaredComponent {
  path: string;
  language: string;
  overrides: RawOverride[];
  line?: number;
}

export interface Declaration {
  file: string;
  standard: string;
  standardLine?: number;
  components: DeclaredComponent[];
  /** Top-level `mirrors:` entries, keyed as global items ("mirrors.auth", "mirrors.npm", ...). */
  globalOverrides: RawOverride[];
}

export const DECLARATION_FILE = ".devguard.yaml";
