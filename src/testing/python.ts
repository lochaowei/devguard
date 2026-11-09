import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import {
  isRecord,
  judgeCoverage,
  parseJson,
  readReport,
  reportMissing,
  testsFailed,
  testToolFailed,
  type Measured,
} from "./coverage.ts";
import { pythonToolRequest, toolErrorLines } from "../tools/runner.ts";
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

/** pytest exit codes: 0 all passed, 1 some failed, 5 no tests collected; anything else is a usage or internal error. */
const PYTEST_RAN = new Set([0, 1, 5]);

/** pytest's usage-error exit code; with `unrecognized arguments: --cov` in its output, pytest-cov is not installed (#109). */
const PYTEST_USAGE_ERROR = 4;
const NO_PYTEST_COV = /unrecognized arguments:.*--cov/;

/** Test ids from pytest's short summary (`FAILED tests/test_a.py::test_x - ...`, `ERROR ...`). */
function failedTests(stdout: string): string[] {
  return [...stdout.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1] ?? "");
}

/** Line and branch totals from `coverage json`, judged separately (SPEC §6.1). */
function totals(text: string | undefined): Measured[] | undefined {
  const report = text === undefined ? undefined : parseJson(text);
  if (!isRecord(report) || !isRecord(report.totals)) return undefined;
  const t = report.totals;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return [
    { metric: "lines", covered: num(t.covered_lines), total: num(t.num_statements) },
    { metric: "branches", covered: num(t.covered_branches), total: num(t.num_branches) },
  ];
}

/**
 * pytest with pytest-cov in branch mode, then `coverage json`. The CLI judges the totals itself rather than through
 * `fail_under`, which in branch mode checks lines and branches combined (SPEC §6.1); `--cov-fail-under=0` keeps the
 * project's own `fail_under` (coverage config or `addopts`) from turning exit 1 on passing tests (#108).
 */
export const pythonTests: TestChecker = {
  language: "python",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const run = (tool: string, args: string[]) => ctx.tools.run({ ...pythonToolRequest(target, tool), args });
    const pytest = await run("pytest", ["--cov", "--cov-branch", "--cov-report=", "--cov-fail-under=0"]);
    if (!PYTEST_RAN.has(pytest.code)) {
      if (pytest.code === PYTEST_USAGE_ERROR && NO_PYTEST_COV.test(`${pytest.stderr}\n${pytest.stdout}`)) {
        // pytest-cov is a plugin with no executable, so the runner never finds it and throws ToolMissingError with
        // the same hint as any missing tool: `uv add --dev "pytest-cov>=6,<8"`, or Poetry's form.
        await run("pytest-cov", []);
      }
      return [testToolFailed(target, "pytest", pytest)];
    }
    const findings: Finding[] = [];
    if (pytest.code === 1) {
      const failed = failedTests(pytest.stdout);
      // Exit 1 with no failing test id (e.g. `-rxXs` hides the FAILED lines) is not a test failure we can name.
      findings.push(
        failed.length > 0 ? testsFailed(target, "uv run pytest", failed) : testToolFailed(target, "pytest", pytest),
      );
    }
    const out = join(ctx.reportDir, "coverage.json");
    const json = await run("coverage", ["json", "--fail-under=0", "-o", out]);
    const measured = json.code === 0 ? totals(await readReport(out)) : undefined;
    if (measured === undefined) {
      const fix = "確認已安裝 pytest-cov，並在元件目錄執行 uv run pytest --cov --cov-branch";
      findings.push(reportMissing(target, "coverage json", fix, toolErrorLines(json).join("\n")));
    } else {
      findings.push(...judgeCoverage(target, measured));
    }
    return findings;
  },
};
