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
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

/** pytest exit codes: 0 all passed, 1 some failed, 5 no tests collected; anything else is a usage or internal error. */
const PYTEST_RAN = new Set([0, 1, 5]);

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
 * `fail_under`, which in branch mode checks lines and branches combined (SPEC §6.1).
 */
export const pythonTests: TestChecker = {
  language: "python",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const run = (tool: string, args: string[]) => ctx.tools.run({ language: "python", tool, dir: target.dir, args });
    const pytest = await run("pytest", ["--cov", "--cov-branch", "--cov-report="]);
    if (!PYTEST_RAN.has(pytest.code)) return [testToolFailed(target, "pytest", pytest)];
    const findings: Finding[] = [];
    if (pytest.code === 1) findings.push(testsFailed(target, "uv run pytest", failedTests(pytest.stdout)));
    const out = join(ctx.reportDir, "coverage.json");
    const json = await run("coverage", ["json", "--fail-under=0", "-o", out]);
    const measured = json.code === 0 ? totals(await readReport(out)) : undefined;
    if (measured === undefined) {
      const fix = "確認已安裝 pytest-cov，並在元件目錄執行 uv run pytest --cov --cov-branch";
      findings.push(reportMissing(target, "coverage json", fix, json.stderr || json.stdout));
    } else {
      findings.push(...judgeCoverage(target, measured));
    }
    return findings;
  },
};
