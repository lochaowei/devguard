import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { runStandardUpgrade } from "../src/standard/upgrade-run.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

/** Helpers for the bundled-standard tests (team@1.1.0, legacy@1.0.0): temp repos and `standard upgrade`. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp repo with these files (paths may include directories); removed after the test. */
export function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-standard-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

export const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

/** A tool runner for checks that must not run any tool or package command. */
export const noTools: ToolRunner = {
  run: () => Promise.reject(new Error("no tools in this test")),
  manage: () => Promise.reject(new Error("no package commands expected")),
};

/** `devguard standard upgrade [target] [--apply]` in `dir`: its exit code and output. */
export async function upgrade(dir: string, options: { apply?: boolean; target?: string } = {}) {
  let out = "";
  const write = (t: string) => (out += t);
  const code = await runStandardUpgrade({ cwd: dir, today: TODAY, apply: false, ...options, tools: noTools, write });
  return { code, out };
}

/** A pyproject.toml that meets the standard except for the type checker tables, which `typecheck` supplies. */
export const pyproject = (typecheck: string) => `[project]
name = "app"
requires-python = ">=3.11"

[tool.ruff]
line-length = 120
target-version = "py311"

[tool.ruff.lint]
select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]

[tool.ruff.lint.mccabe]
max-complexity = 10

[tool.ruff.lint.per-file-ignores]
"**/tests/**" = ["S101"]
"**/test_*.py" = ["S101"]
${typecheck}
[tool.coverage.run]
branch = true
`;
