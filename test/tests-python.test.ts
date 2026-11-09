import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolRequest, ToolResult } from "../src/tools/runner.ts";
import { ToolMissingError } from "../src/tools/runner.ts";
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

  it("overrides the project's own coverage floor so only devguard judges coverage (#108)", async () => {
    const { tools, calls } = python({ covered_lines: 90, num_statements: 100, num_branches: 10, covered_branches: 9 });
    await check(tools);
    expect(calls[0]?.args).toContain("--cov-fail-under=0");
  });

  it("passes pytest's standard range to the runner, for the install hint when it is missing (#68)", async () => {
    const { tools, calls } = python({ covered_lines: 90, num_statements: 100, num_branches: 10, covered_branches: 9 });
    await check(tools);
    expect(calls.map((c) => [c.tool, c.range])).toEqual([
      ["pytest", ">=8,<10"],
      ["coverage", undefined],
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

  it("reports exit 1 with no failing test id as a tool failure with the output tail, still judging coverage (#108)", async () => {
    const totals = { covered_lines: 90, num_statements: 100, num_branches: 10, covered_branches: 9 };
    const pytest = ok("1371 passed, 33 skipped in 45.39s\nFAIL Required test coverage of 100.0% not reached.", 1);
    const r = await check(python(totals, pytest).tools);
    expect(rules(r.findings)).toEqual(["error:test/tool-failed"]);
    expect(r.findings[0]?.message).toContain("Required test coverage");
  });

  it("reports pytest-cov as a missing tool when pytest does not know --cov (#109)", async () => {
    const pytest = ok("", 4, "pytest: error: unrecognized arguments: --cov --cov-branch --cov-report=");
    const { tools, calls } = fakeTools((req: ToolRequest) => {
      if (req.tool === "pytest") return pytest;
      throw new ToolMissingError("找不到 pytest-cov", `uv add --dev "pytest-cov${req.range ?? ""}"`);
    });
    await expect(check(tools)).rejects.toMatchObject({
      message: "找不到 pytest-cov",
      install: 'uv add --dev "pytest-cov>=6,<8"',
    });
    expect(calls.map((c) => c.tool)).toEqual(["pytest", "pytest-cov"]);
  });

  it("keeps other pytest exit 4 as a tool failure (#109)", async () => {
    const pytest = ok("", 4, "ERROR: file or directory not found: tests/nope");
    const { tools, calls } = python(undefined, pytest);
    expect(rules((await check(tools)).findings)).toEqual(["error:test/tool-failed"]);
    expect(calls.map((c) => c.tool)).toEqual(["pytest"]);
  });

  it("words the tool-failed hint with single spaces for a root component (#109)", async () => {
    const pytest = ok("", 4, "boom");
    const r = await checkTests(project(declare("", "python")), python(undefined, pytest).tools, ["app.py"]);
    expect(r.findings[0]?.fix).toBe("在 repo 根目錄 直接執行 pytest 查看完整訊息");
  });

  it("reports a missing coverage report when coverage has no data", async () => {
    const r = await check(python(undefined).tools);
    expect(rules(r.findings)).toEqual(["error:coverage/no-report"]);
    expect(r.findings[0]?.message).toContain("No data to report");
  });

  it("explains a missing coverage report from stdout when stderr holds only colour codes (#128)", async () => {
    const { tools } = fakeTools((req: ToolRequest) =>
      req.tool === "pytest" ? ok("3 passed") : ok("No data to report.", 1, "\x1b[0m\n"),
    );
    const r = await check(tools);
    expect(r.findings[0]?.message).toContain("（No data to report.）");
  });
});
