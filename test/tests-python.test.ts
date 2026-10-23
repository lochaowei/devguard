import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolRequest, ToolResult } from "../src/tools/runner.ts";
import { rules } from "./helpers.ts";
import { checkTests, declare, fakeTools, ok, project } from "./tests-helpers.ts";

/** `totals` of `coverage json`, trimmed to the fields the CLI reads. */
interface Totals {
  covered_lines: number;
  num_statements: number;
  num_branches?: number;
  covered_branches?: number;
}

const PYTEST_FAILED = `============================= test session starts =============================
collected 3 items

tests/test_a.py .F.                                                       [100%]

=========================== short test summary info ===========================
FAILED tests/test_a.py::test_parse_empty - AssertionError: assert 1 == 0
========================= 1 failed, 2 passed in 0.12s =========================
`;

/** pytest answers with `pytest`, then `coverage json` writes these totals to its `-o` path. */
function python(totals: Totals | undefined, pytest: ToolResult = ok("3 passed")) {
  return fakeTools((req: ToolRequest) => {
    if (req.tool === "pytest") return pytest;
    const args = req.args ?? [];
    const out = args[args.indexOf("-o") + 1];
    if (totals === undefined || out === undefined) return ok("", 1, "No data to report.");
    writeFileSync(out, JSON.stringify({ meta: { branch_coverage: true }, files: {}, totals }));
    return ok(`Wrote JSON report to ${out}`);
  });
}

const API = declare("api/", "python");
const check = (tools: ReturnType<typeof python>["tools"], declaration = API) =>
  checkTests(project(declaration), tools, ["api/app.py"]);

describe("Python tests", () => {
  it("runs pytest with branch coverage, then coverage json, in the component", async () => {
    const { tools, calls } = python({ covered_lines: 90, num_statements: 100, num_branches: 10, covered_branches: 9 });
    expect((await check(tools)).findings).toEqual([]);
    expect(calls.map((c) => `${c.dir}:${c.tool} ${(c.args ?? []).slice(0, 3).join(" ")}`)).toEqual([
      "api/:pytest --cov --cov-branch --cov-report=",
      "api/:coverage json --fail-under=0 -o",
    ]);
  });

  it("judges line and branch coverage from the totals separately", async () => {
    const lowBranches = { covered_lines: 95, num_statements: 100, num_branches: 40, covered_branches: 30 };
    const r = await check(python(lowBranches).tools);
    expect(rules(r.findings)).toEqual(["error:coverage/branches"]);
    expect(r.findings[0]?.message).toBe("分支覆蓋率 75%（30/40）低於門檻 80%");
    const lowLines = { covered_lines: 79, num_statements: 100, num_branches: 40, covered_branches: 40 };
    expect(rules((await check(python(lowLines).tools)).findings)).toEqual(["error:coverage/lines"]);
  });

  it("applies the declared threshold", async () => {
    const totals = { covered_lines: 70, num_statements: 100, num_branches: 10, covered_branches: 7 };
    const declaration = declare("api/", "python", '{coverage.lines: {value: 70, reason: "legacy", until: 2099-01-01}}');
    expect(rules((await check(python(totals).tools, declaration)).findings)).toEqual([
      "deviation:declaration/deviation",
    ]);
  });

  it("reports failing tests by name, apart from coverage", async () => {
    const totals = { covered_lines: 50, num_statements: 100, num_branches: 0, covered_branches: 0 };
    const r = await check(python(totals, ok(PYTEST_FAILED, 1)).tools);
    expect(rules(r.findings)).toEqual(["error:test/failed", "error:coverage/lines"]);
    expect(r.findings[0]?.message).toBe("測試失敗：tests/test_a.py::test_parse_empty");
  });

  it("reports a pytest usage error (e.g. pytest-cov not installed) as a tool failure without judging coverage", async () => {
    const pytest = ok("", 4, "pytest: error: unrecognized arguments: --cov --cov-branch");
    const { tools, calls } = python(undefined, pytest);
    const r = await check(tools);
    expect(rules(r.findings)).toEqual(["error:test/tool-failed"]);
    expect(r.findings[0]?.message).toContain("unrecognized arguments");
    expect(calls.map((c) => c.tool)).toEqual(["pytest"]);
  });

  it("reports a missing coverage report when coverage has no data", async () => {
    const r = await check(python(undefined).tools);
    expect(rules(r.findings)).toEqual(["error:coverage/no-report"]);
    expect(r.findings[0]?.message).toContain("No data to report");
  });
});
