import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_LAYERS, checkTestsAndCoverage } from "../src/check.ts";
import type { CheckScope } from "../src/layers/types.ts";
import type { ToolRequest, ToolResult } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";
import { argValue, checkTests, declare, fakeTools, ok, project } from "./tests-helpers.ts";

type Pct = Record<"lines" | "branches" | "functions" | "statements", number>;

const ALL_80: Pct = { lines: 80, branches: 80, functions: 80, statements: 80 };

/** Writes an istanbul json-summary with these percentages (of 200 items each) to `dir`. */
function writeSummary(dir: string, pct: Pct): void {
  mkdirSync(dir, { recursive: true });
  const metric = (p: number) => ({ total: 200, covered: p * 2, skipped: 0, pct: p });
  const total = Object.fromEntries(Object.entries(pct).map(([k, p]) => [k, metric(p)]));
  writeFileSync(join(dir, "coverage-summary.json"), JSON.stringify({ total }));
}

/** A Jest-style JSON test report, as printed by `vitest --reporter=json` and `jest --json`. */
function testReport(failed: string[] = []): string {
  return JSON.stringify({
    numFailedTests: failed.length,
    numFailedTestSuites: failed.length > 0 ? 1 : 0,
    testResults: [
      {
        name: "/repo/web/a.test.ts",
        status: failed.length > 0 ? "failed" : "passed",
        assertionResults: [
          { fullName: "a works", status: "passed" },
          ...failed.map((fullName) => ({ fullName, status: "failed" })),
        ],
      },
    ],
  });
}

/**
 * A vitest run: `failed` tests fail, the JSON test report goes to its output file, and the coverage summary has these
 * percentages. `result` replaces the run's answer and writes no test report file.
 */
function vitest(pct: Pct, failed: string[] = [], result?: (req: ToolRequest) => ToolResult) {
  return fakeTools((req) => {
    writeSummary(argValue(req, "--coverage.reportsDirectory"), pct);
    if (result) return result(req);
    writeFileSync(argValue(req, "--outputFile.json"), testReport(failed));
    return ok("JSON report written to ...", failed.length > 0 ? 1 : 0);
  });
}

const WEB = declare("web/", "typescript");
const webWith = (coverage: string) => declare("web/", "typescript", `{coverage.lines: ${coverage}}`);

function check(declaration: string, tools: ReturnType<typeof vitest>["tools"], scope: CheckScope = { full: true }) {
  return checkTests(project(declaration), tools, ["web/a.ts", "README.md"], scope);
}

describe("tests and coverage in devguard check", () => {
  it("runs only with --full", async () => {
    const { tools, calls } = vitest(ALL_80);
    expect((await check(WEB, tools, { full: false })).findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips tests with --only", async () => {
    const { tools, calls } = vitest(ALL_80);
    await check(WEB, tools, { full: true, only: "lint" });
    expect(calls).toEqual([]);
  });

  it("skips components without files", async () => {
    const { tools, calls } = vitest(ALL_80);
    await checkTests(project(WEB), tools, ["README.md", "tools/x.ts"]);
    expect(calls).toEqual([]);
  });

  it("runs each component's tests with --full and judges coverage against the standard", async () => {
    const { tools, calls } = vitest({ ...ALL_80, lines: 70 });
    const r = await check(WEB, tools);
    expect(calls.map((c) => `${c.dir}:${c.tool}`)).toEqual(["web/:vitest"]);
    expect(r.findings).toEqual([
      expect.objectContaining({
        level: "error",
        layer: "code",
        rule: "coverage/lines",
        component: "web/ (TypeScript)",
        message: "行覆蓋率 70%（140/200）低於門檻 80%",
      }),
    ]);
  });

  it("holds coverage to an accepted deviation in the declaration", async () => {
    const declaration = webWith('{value: 60, reason: "舊程式碼補測試中", until: 2099-03-31}');
    const pass = await check(declaration, vitest({ ...ALL_80, lines: 65 }).tools);
    expect(rules(pass.findings)).toEqual(["deviation:declaration/deviation"]);
    const fail = await check(declaration, vitest({ ...ALL_80, lines: 55 }).tools);
    expect(rules(fail.findings)).toEqual(["deviation:declaration/deviation", "error:coverage/lines"]);
    expect(fail.findings[1]?.message).toContain("門檻 60%（宣告的偏離值）");
  });

  it("holds coverage to the standard when a looser override has no reason", async () => {
    const r = await check(webWith("60"), vitest({ ...ALL_80, lines: 65 }).tools);
    expect(rules(r.findings)).toEqual(["error:declaration/looser-without-reason", "error:coverage/lines"]);
  });

  it("holds all four TypeScript coverage totals to a stricter override", async () => {
    const r = await check(webWith("90"), vitest(ALL_80).tools);
    expect(rules(r.findings)).toEqual([
      "error:coverage/lines",
      "error:coverage/branches",
      "error:coverage/functions",
      "error:coverage/statements",
    ]);
  });
});

describe("checkTestsAndCoverage (pre-push)", () => {
  it("runs the declaration and every component's tests, with no other checks", async () => {
    const { tools, calls } = vitest({ ...ALL_80, statements: 10 });
    const cwd = project(WEB);
    const r = await checkTestsAndCoverage({ cwd, today: TODAY, tools, listFiles: () => Promise.resolve(["web/a.ts"]) });
    expect(calls.map((c) => c.tool)).toEqual(["vitest"]);
    expect(rules(r.findings)).toEqual(["error:coverage/statements"]);
    expect(r.components.map((c) => c.name)).toEqual(["web/ (TypeScript)"]);
  });

  it("is part of devguard check --full", () => {
    expect(CHECK_LAYERS.map((l) => l.id)).toContain("tests");
  });
});

describe("TypeScript tests", () => {
  it("runs vitest with a json-summary in a temp directory and a JSON test report", async () => {
    const { tools, calls } = vitest(ALL_80);
    expect((await check(WEB, tools)).findings).toEqual([]);
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(["run", "--coverage.enabled=true", "--coverage.reporter=json-summary"]);
    expect(args).toContain("--reporter=json");
  });

  it("reports failing tests apart from coverage", async () => {
    const r = await check(WEB, vitest({ ...ALL_80, branches: 50 }, ["a > handles empty input"]).tools);
    expect(rules(r.findings)).toEqual(["error:test/failed", "error:coverage/branches"]);
    expect(r.findings[0]?.message).toBe("測試失敗：a > handles empty input");
    expect(r.findings[0]?.fix).toContain("web/");
  });

  it("does not count the tool's own threshold failure as a failing test", async () => {
    const r = await check(WEB, vitest({ ...ALL_80, lines: 79 }, [], () => ok(testReport(), 1)).tools);
    expect(rules(r.findings)).toEqual(["error:coverage/lines"]);
  });

  it("finds the JSON report among lines the tests printed", async () => {
    const noisy = () => ok(`stdout | a.test.ts\nhello\n${testReport(["b fails"])}\n`, 1);
    const r = await check(WEB, vitest(ALL_80, [], noisy).tools);
    expect(rules(r.findings)).toEqual(["error:test/failed"]);
  });

  it("names a test file that fails to load", async () => {
    const report = JSON.stringify({
      numFailedTests: 0,
      numFailedTestSuites: 1,
      testResults: [{ name: "/repo/web/b.test.ts", status: "failed", assertionResults: [] }],
    });
    const r = await check(WEB, vitest(ALL_80, [], () => ok(report, 1)).tools);
    expect(r.findings[0]?.message).toBe("測試失敗：/repo/web/b.test.ts");
  });

  it("reports failures the report does not name", async () => {
    const report = JSON.stringify({ numFailedTests: 2 });
    const r = await check(WEB, vitest(ALL_80, [], () => ok(report, 1)).tools);
    expect(r.findings.map((f) => f.message)).toEqual(["測試失敗"]);
  });

  it("runs jest when the declaration picks it", async () => {
    const { tools, calls } = fakeTools((req) => {
      writeSummary(argValue(req, "--coverageDirectory"), { ...ALL_80, functions: 10 });
      writeFileSync(argValue(req, "--outputFile"), testReport(["b fails"]));
      return ok("", 1);
    });
    const r = await check(declare("web/", "typescript", "{test.tool: jest}"), tools);
    expect(calls.map((c) => c.tool)).toEqual(["jest"]);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--ci", "--coverage", "--json"]));
    expect(rules(r.findings)).toEqual(["error:test/failed", "error:coverage/functions"]);
  });

  it("reports a run that printed no test report as a tool failure", async () => {
    const r = await check(WEB, vitest(ALL_80, [], () => ok("", 1, "Error: Cannot find module 'vitest/config'")).tools);
    expect(rules(r.findings)).toEqual(["error:test/tool-failed"]);
    expect(r.findings[0]?.message).toContain("Cannot find module");
  });

  it("reports a missing coverage report", async () => {
    const { tools } = fakeTools(() => ok(testReport()));
    const r = await check(WEB, tools);
    expect(rules(r.findings)).toEqual(["error:coverage/no-report"]);
  });

  it("passes a total with nothing to cover", async () => {
    const { tools } = fakeTools((req) => {
      const dir = argValue(req, "--coverage.reportsDirectory");
      writeSummary(dir, ALL_80);
      const none = { total: 0, covered: 0, skipped: 0, pct: "Unknown" };
      const summary = { total: { lines: none, branches: none, functions: none, statements: none } };
      writeFileSync(join(dir, "coverage-summary.json"), JSON.stringify(summary));
      return ok(testReport());
    });
    expect((await check(WEB, tools)).findings).toEqual([]);
  });
});
