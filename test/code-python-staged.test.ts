import { describe, expect, it } from "vitest";
import { pythonChecker } from "../src/code/python.ts";
import type { CodeCategory, CodeTarget } from "../src/code/types.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (...parts: string[]) => [CWD, ...parts].join(process.platform === "win32" ? "\\" : "/");

function fakeTools(replies: Record<string, Partial<ToolResult>>) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const key = req.tool === "ruff" ? `ruff ${req.args?.[0] ?? ""}` : req.tool;
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...replies[key] });
    },
  };
  return { tools, calls };
}

const only = (...c: CodeCategory[]) => new Set<CodeCategory>(c);

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "api/ (Python)",
    dir: "api/",
    language: "python",
    effective: { "lint.tool": "ruff", "typecheck.tool": "mypy" },
    categories: only("lint", "format", "typecheck"),
    ...over,
  };
}

describe("python checker: staged versions (pre-commit, SPEC §7.4)", () => {
  const staged = (path: string) => Promise.resolve(path === "api/src/app.py" ? "import os\n" : undefined);
  const run = (t: CodeTarget, tools: ToolRunner) =>
    pythonChecker.check(t, { cwd: CWD, tools, readText: () => Promise.resolve(undefined), staged });

  it("feeds the staged version to ruff check and ruff format through stdin", async () => {
    const lintOut = JSON.stringify([
      { code: "F401", message: "unused", filename: abs("api", "src", "app.py"), location: { row: 1 } },
    ]);
    const { tools, calls } = fakeTools({
      "ruff check": { code: 1, stdout: lintOut },
      "ruff format": { code: 0, stdout: "import os\n\n" },
    });
    const findings = await run(target({ files: ["src/app.py"], categories: only("lint", "format") }), tools);
    expect(findings.map((f) => `${f.rule} ${f.file ?? ""}:${String(f.line)}`)).toEqual([
      "ruff/F401 api/src/app.py:1",
      "ruff/format api/src/app.py:2",
    ]);
    expect(calls.map((c) => [c.args?.slice(-3), c.stdin])).toEqual([
      [["--stdin-filename", "src/app.py", "-"], "import os\n"],
      [["--stdin-filename", "src/app.py", "-"], "import os\n"],
    ]);
  });

  it("reports a ruff format failure on staged content", async () => {
    const { tools } = fakeTools({ "ruff format": { code: 2, stderr: "boom" } });
    const findings = await run(target({ files: ["src/app.py"], categories: only("format") }), tools);
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });

  it("checks files that are not staged on disk, and names mypy as reading the working tree", async () => {
    const { tools, calls } = fakeTools({ "ruff check": { stdout: "[]" } });
    await run(target({ files: ["src/other.py"], categories: only("lint") }), tools);
    expect(calls[0]?.args?.at(-1)).toBe("src/other.py");
    expect(calls[0]?.stdin).toBeUndefined();
    expect(pythonChecker.workingTreeTools(target())).toEqual(["mypy"]);
    expect(pythonChecker.workingTreeTools(target({ effective: { "typecheck.tool": "pyright" } }))).toEqual(["pyright"]);
    expect(pythonChecker.workingTreeTools(target({ categories: only("lint") }))).toEqual([]);
  });
});
