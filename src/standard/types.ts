/** How an override of a standard item is judged: which direction is "stricter". See SPEC §4.2. */
export type Kind =
  | "max" // lower is stricter
  | "min" // higher is stricter
  | "minVersion" // dotted version, higher is stricter
  | "bool" // true is stricter
  | "severity" // lower level is stricter
  | "list" // removing entries is looser, adding is stricter (banned lists, rule sets)
  | "choice" // value in `allowed` is an alternative, anything else is looser
  | "versionRange" // tool version range such as ">=0.17,<0.18"; admitting any version outside it is looser
  | "style" // no strictness: overriding is never a deviation
  | "mirror" // a mirror URL: another repository on the same host is a style change, another host is looser
  | "ignoredVulns"; // each entry is looser and needs reason + until

export type Scalar = string | number | boolean;
export type ItemValue = Scalar | string[] | IgnoredVuln[];

export interface IgnoredVuln {
  id: string;
  reason?: string;
  until?: string;
}

export interface ItemDef {
  kind: Kind;
  label: string;
  value: ItemValue;
  /** Only for kind "choice": the alternatives that are not deviations. */
  allowed?: readonly string[];
  /**
   * Only for kind "versionRange": the names the project's dependency manager pins the tool under (uv.lock package,
   * npm package, go.mod tool path, Maven artifactId / Gradle plugin id or toolVersion block). See src/versions/pinned.ts.
   */
  pinnedAs?: readonly string[];
  /** Only for kind "versionRange": the tool is a binary on PATH (golangci-lint), not pinned by the project. */
  onPath?: true;
}

export type Language = "python" | "go" | "typescript" | "java";

export const LANGUAGES: readonly Language[] = ["python", "go", "typescript", "java"];

export const LANGUAGE_LABEL: Record<Language, string> = {
  python: "Python",
  go: "Go",
  typescript: "TypeScript",
  java: "Java",
};

export const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".java": "java",
};

export interface Standard {
  /** e.g. "team@1.0.0" */
  id: string;
  /** Items that apply to the whole repo (mirrors, Claude Code version). */
  global: Readonly<Record<string, ItemDef>>;
  languages: Readonly<Record<Language, Readonly<Record<string, ItemDef>>>>;
  /**
   * A standard that is a stepping stone to another one (legacy → team): the version `standard upgrade` moves it to
   * once its own standard has no newer version bundled. That version and its newer versions are valid targets.
   */
  upgradesTo?: string;
  /** Set when the team deprecates this version. */
  deprecated?: { until: string };
}

export const SEVERITIES = ["any", "low", "moderate", "high", "critical"] as const;
