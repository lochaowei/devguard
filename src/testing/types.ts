import type { Finding } from "../report/finding.ts";
import type { Language } from "../standard/types.ts";
import type { ToolRunner } from "../tools/runner.ts";

/** One component whose tests run under `check --full` (SPEC §7.1). */
export interface TestTarget {
  /** Component display name such as "web/ (TypeScript)". */
  component: string;
  /** Where the tests run: normalized, "" for the repo root, otherwise ending in "/". */
  dir: string;
  language: Language;
  /** Effective standard values for the component (`test.tool`, `build.tool`...). */
  effective: Readonly<Record<string, unknown>>;
  /** The coverage threshold in force (%): the declared `coverage.lines`, including an accepted deviation. */
  threshold: number;
  /** True when the threshold is a deviation the declaration accepted. */
  deviation: boolean;
}

export interface TestContext {
  /** Repo root. */
  cwd: string;
  /** Throws ToolMissingError when a tool is not installed; let it propagate (exit 2). */
  tools: ToolRunner;
  /** A fresh, empty, absolute directory for report files; removed after the run. */
  reportDir: string;
}

/**
 * Runs one language's tests with coverage, then judges test failures and coverage separately (layer "code").
 * Register an implementation in TEST_CHECKERS (src/testing/registry.ts).
 */
export interface TestChecker {
  language: Language;
  check(target: TestTarget, ctx: TestContext): Promise<Finding[]>;
}
