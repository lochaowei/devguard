import type { Repair } from "../fix/repair.ts";

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
  /** 1-based column, when the tool reports one. */
  column?: number;
  /** How to resolve it: a command, or what to edit by hand. */
  fix?: string;
  /** What `devguard fix` does about it, by file category (SPEC §9.2). Internal: not part of the JSON report. */
  repairs?: Repair[];
  /**
   * Set by settings checks when a tool config file holds another value than the declaration: the standard item and
   * the value read. Lets `devguard draft` turn existing settings into overrides (SPEC §4.3).
   */
  observed?: { key: string; value: unknown };
  /** Whether `devguard fix` can resolve it. When absent, inferred from `fix` (see `isFixable`). */
  fixable?: boolean;
}

export const LEVEL_ORDER: readonly Level[] = ["error", "deviation", "hint"];

export const LEVEL_LABEL: Record<Level, string> = {
  error: "錯誤",
  deviation: "偏離",
  hint: "提示",
};

/** Whether `devguard fix` (or `fix --code`) resolves the finding (SPEC §11 text format). */
export function isFixable(f: Finding): boolean {
  return f.fixable ?? f.fix?.startsWith("devguard fix") ?? false;
}

/** The message on a single line, for line-oriented formats. */
export function oneLine(message: string): string {
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}
