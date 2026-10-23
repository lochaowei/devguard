import type { Finding } from "../report/finding.ts";
import type { Language } from "../standard/types.ts";
import type { ToolRunner } from "../tools/runner.ts";

/** The kinds of code check a language can run; `--only <類別>` picks one. */
export const CODE_CATEGORIES = ["lint", "format", "typecheck"] as const;
export type CodeCategory = (typeof CODE_CATEGORIES)[number];

/** One unit of code checking: a component (or the files no component covers) of one language. */
export interface CodeTarget {
  /** Component display name such as "web/ (TypeScript)"; absent for files no component covers. */
  component?: string;
  /** Where the tools run: normalized, "" for the repo root, otherwise ending in "/". */
  dir: string;
  language: Language;
  /** Effective standard values for this target (`lint.tool`, `format.printWidth`...) and the repo-wide `mirrors.*`. */
  effective: Readonly<Record<string, unknown>>;
  /**
   * Files to check, relative to `dir`. Absent means the whole directory: file-level checks run on "." and
   * type checks on the whole project. Type checks always cover the whole project (SPEC §7.1).
   */
  files?: readonly string[];
  /** The categories to run; never empty. */
  categories: ReadonlySet<CodeCategory>;
}

export interface CodeCheckContext {
  /** Repo root. */
  cwd: string;
  /** Throws ToolMissingError when a tool is not installed; let it propagate (exit 2). */
  tools: ToolRunner;
  /** Contents of a repo-relative file, or undefined when it cannot be read. */
  readText: (repoPath: string) => Promise<string | undefined>;
}

/**
 * Runs one language's lint, format and type-check tools and turns their output into findings
 * (layer "code", repo-relative `file`, `line` and a `rule` prefixed with the tool name).
 * Register an implementation in CODE_CHECKERS (src/code/registry.ts).
 */
export interface CodeChecker {
  language: Language;
  check(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]>;
  /** The formatter and lint-fix runs that resolve the target's fixable findings, in order (`fix --code`). */
  fixSteps(target: CodeTarget, ctx: CodeCheckContext): Promise<FixStep[]>;
}

/** One tool run that changes files in place, for `devguard fix --code` (SPEC §9.1). */
export interface FixStep {
  /** As in ToolRequest.tool. */
  tool: string;
  args: readonly string[];
  /** File arguments, appended in batches short enough for cmd.exe; absent means none. */
  files?: readonly string[];
  env?: Readonly<Record<string, string>>;
  /** The highest exit code that still means the tool ran (1 for a tool that exits 1 when problems are left). */
  okUpTo: number;
}
