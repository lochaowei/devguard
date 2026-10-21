export type Level = "error" | "deviation" | "hint";

/** The three check layers from SPEC §1, plus findings about the code itself. */
export type Layer = "config" | "environment" | "consistency" | "code";

export interface Finding {
  level: Level;
  layer: Layer;
  /** Stable id such as "declaration/looser-without-reason". */
  rule: string;
  message: string;
  /** Component display name, e.g. "web/ (TypeScript)". Absent for repo-wide findings. */
  component?: string;
  file?: string;
  line?: number;
  /** How to resolve it: a command, or what to edit by hand. */
  fix?: string;
}

export const LEVEL_ORDER: readonly Level[] = ["error", "deviation", "hint"];

export const LEVEL_LABEL: Record<Level, string> = {
  error: "錯誤",
  deviation: "偏離",
  hint: "提示",
};
