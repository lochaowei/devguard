import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_HANDLERS } from "../src/hooks/registry.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";
import { argValue, declare, fakeTools, ok, project } from "./tests-helpers.ts";

/** A vitest run where `failed` tests fail and every coverage metric is `pct`%. */
function vitest(pct: number, failed: string[] = []) {
  return fakeTools((req) => {
    const reports = argValue(req, "--coverage.reportsDirectory");
    mkdirSync(reports, { recursive: true });
    const metric = { total: 100, covered: pct, skipped: 0, pct };
    const total = { lines: metric, branches: metric, functions: metric, statements: metric };
    writeFileSync(join(reports, "coverage-summary.json"), JSON.stringify({ total }));
    const results = [
      { fullName: "a works", status: "passed" },
      ...failed.map((n) => ({ fullName: n, status: "failed" })),
    ];
    writeFileSync(
      argValue(req, "--outputFile.json"),
      JSON.stringify({
        numFailedTests: failed.length,
        testResults: [
          { name: "/repo/a.test.ts", status: failed.length ? "failed" : "passed", assertionResults: results },
        ],
      }),
    );
    return ok("", failed.length > 0 ? 1 : 0);
  });
}

async function prePush(dir: string, tools: ToolRunner) {
  const handler = HOOK_HANDLERS["git-pre-push"];
  if (!handler) throw new Error("git-pre-push is not registered");
  let out = "";
  const code = await handler({ cwd: dir, today: TODAY, tools, write: (t) => (out += t) });
  return { code, out };
}

describe("devguard hook git-pre-push (SPEC §7.1, §7.4)", () => {
  it("passes silently when the tests pass and coverage meets the standard", async () => {
    const { tools, calls } = vitest(95);
    const r = await prePush(project(declare("./", "typescript"), { "a.ts": "export const a = 1;\n" }), tools);
    expect(calls.length).toBeGreaterThan(0);
    expect(r).toEqual({ code: 0, out: "" });
  });

  it("blocks the push and names the failing test", async () => {
    const { tools } = vitest(95, ["a breaks"]);
    const r = await prePush(project(declare("./", "typescript"), { "a.ts": "export const a = 1;\n" }), tools);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("test/failed");
    expect(r.out).toContain("a breaks");
  });

  it("blocks the push when coverage is below the standard", async () => {
    const { tools } = vitest(10);
    const r = await prePush(project(declare("./", "typescript"), { "a.ts": "export const a = 1;\n" }), tools);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("coverage/lines");
  });
});
