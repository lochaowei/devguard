/** How an override of a standard item is judged: which direction is "stricter". See SPEC §4.2. */
export type Kind =
  | "max" // lower is stricter
  | "min" // higher is stricter
  | "minVersion" // dotted version, higher is stricter
  | "bool" // true is stricter
  | "severity" // lower level is stricter
  | "list" // removing entries is looser, adding is stricter (banned lists, rule sets)
  | "choice" // value in `allowed` is an alternative, anything else is looser
  | "style" // no strictness: overriding is never a deviation
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
  /** Set when the team deprecates this version. */
  deprecated?: { until: string };
}

export const SEVERITIES = ["any", "low", "moderate", "high", "critical"] as const;
