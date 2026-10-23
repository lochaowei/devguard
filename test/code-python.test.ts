import { describe, expect, it } from "vitest";
import { pythonChecker } from "../src/code/python.ts";
import type { CodeCategory, CodeTarget } from "../src/code/types.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (...parts: string[]) => [CWD, ...parts].join(process.platform === "win32" ? "\\" : "/");

type Reply = Partial<ToolResult>;

/** A tool runner that answers by tool name (and first argument for Ruff) and records every request. */
function fakeTools(replies: Record<string, Reply>) {
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

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "api/ (Python)",
    dir: "api/",
    language: "python",
    effective: { "lint.tool": "ruff", "typecheck.tool": "mypy" },
    categories: new Set<CodeCategory>(["lint", "format", "typecheck"]),
    ...over,
  };
}

function check(t: CodeTarget, tools: ToolRunner) {
  return pythonChecker.check(t, { cwd: CWD, tools, readText: () => Promise.resolve(undefined) });
}

const only = (...c: CodeCategory[]) => new Set<CodeCategory>(c);

describe("python checker: Ruff lint", () => {
  it("turns Ruff diagnostics into findings with file, line and rule", async () => {
    const stdout = JSON.stringify([
      {
        code: "F401",
        message: "`os` imported but unused",
        filename: abs("api", "src", "app.py"),
        location: { row: 1, column: 8 },
        end_location: { row: 1, column: 10 },
        fix: null,
        noqa_row: 1,
        url: "https://docs.astral.sh/ruff/rules/unused-import",
      },
      {
        code: null,
        message: "SyntaxError: Expected an expression",
        filename: abs("api", "src", "broken.py"),
        location: { row: 4, column: 5 },
      },
    ]);
    const { tools, calls } = fakeTools({ "ruff check": { code: 1, stdout } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(calls).toEqual([
      {
        language: "python",
        tool: "ruff",
        dir: "api/",
        args: ["check", "--output-format", "json", "--no-fix", "--force-exclude", "."],
      },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "ruff/F401",
        message: "`os` imported but unused",
        component: "api/ (Python)",
        file: "api/src/app.py",
        line: 1,
        fix: "devguard fix --code api/src/app.py",
        fixable: true,
      },
      expect.objectContaining({ level: "error", rule: "ruff/syntax-error", file: "api/src/broken.py", line: 4 }),
    ]);
  });

  it("passes only the given files, relative to the component", async () => {
    const { tools, calls } = fakeTools({ "ruff check": { stdout: "[]" } });
    const findings = await check(target({ categories: only("lint"), files: ["src/a.py", "b.py"] }), tools);
    expect(findings).toEqual([]);
    expect(calls[0]?.args?.slice(-2)).toEqual(["src/a.py", "b.py"]);
  });

  it("reports a Ruff error (exit 2) as a failed run", async () => {
    const { tools } = fakeTools({ "ruff check": { code: 2, stderr: "ruff failed\n  Cause: bad pyproject.toml" } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(findings).toEqual([expect.objectContaining({ level: "error", rule: "code/tool-failed" })]);
    expect(findings[0]?.message).toContain("bad pyproject.toml");
  });
});

describe("python checker: Ruff format", () => {
  it("reports each unformatted file at its first changed line", async () => {
    const stdout = [
      "--- src/app.py",
      "+++ src/app.py",
      "@@ -3,7 +3,7 @@",
      " import sys",
      " ",
      " ",
      "-x  = 1",
      "+x = 1",
      " ",
      "@@ -20,3 +20,3 @@",
      "-y=2",
      "+y = 2",
      "",
      "--- " + abs("api", "b.py"),
      "+++ " + abs("api", "b.py"),
      "@@ -1,2 +1,3 @@",
      " a = 1",
      "+",
      "",
    ].join("\n");
    const { tools, calls } = fakeTools({ "ruff format": { code: 1, stdout } });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(calls).toEqual([
      { language: "python", tool: "ruff", dir: "api/", args: ["format", "--diff", "--force-exclude", "."] },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "ruff/format",
        message: "格式不符合 Ruff format",
        component: "api/ (Python)",
        file: "api/src/app.py",
        line: 6,
        fix: "devguard fix --code api/src/app.py",
        fixable: true,
      },
      expect.objectContaining({ rule: "ruff/format", file: "api/b.py", line: 2 }),
    ]);
  });

  it("passes when every file is formatted", async () => {
    const { tools } = fakeTools({ "ruff format": { code: 0, stderr: "3 files already formatted\n" } });
    expect(await check(target({ categories: only("format"), files: ["a.py"] }), tools)).toEqual([]);
  });

  it("reports a Ruff format error as a failed run", async () => {
    const { tools } = fakeTools({ "ruff format": { code: 2, stderr: "error: Failed to parse a.py" } });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });

  it("does not treat a removed '-- ...' line inside a diff hunk as a file header", async () => {
    const stdout = [
      "--- src/app.py",
      "+++ src/app.py",
      "@@ -10,3 +10,3 @@",
      "-- legacy comment",
      "+# legacy comment",
      "",
    ].join("\n");
    const { tools } = fakeTools({ "ruff format": { code: 1, stdout } });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(findings).toEqual([expect.objectContaining({ rule: "ruff/format", file: "api/src/app.py", line: 10 })]);
  });
});

describe("python checker: mypy", () => {
  it("turns mypy errors into findings and checks the whole component even for a file list", async () => {
    const stdout = [
      'src/app.py:3: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
      "src/app.py:3: note: See https://mypy.rtfd.io/en/stable/_refs.html#code-assignment for more info",
      "src\\util.py:12: error: Function is missing a return type annotation  [no-untyped-def]",
      "pyproject.toml: error: Unrecognized option: bogus = 1",
      "",
    ].join("\r\n");
    const { tools, calls } = fakeTools({ mypy: { code: 1, stdout } });
    const findings = await check(target({ categories: only("typecheck"), files: ["src/app.py"] }), tools);
    expect(calls).toEqual([
      {
        language: "python",
        tool: "mypy",
        dir: "api/",
        args: ["--no-pretty", "--no-error-summary", "--show-error-codes", "--no-color-output", "."],
      },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "mypy/assignment",
        message: 'Incompatible types in assignment (expression has type "str", variable has type "int")',
        component: "api/ (Python)",
        file: "api/src/app.py",
        line: 3,
        fix: "手動修正型別錯誤",
        fixable: false,
      },
      expect.objectContaining({ rule: "mypy/no-untyped-def", file: "api/src/util.py", line: 12 }),
      expect.objectContaining({
        rule: "mypy/error",
        file: "api/pyproject.toml",
        message: "Unrecognized option: bogus = 1",
      }),
    ]);
  });

  it("passes when mypy exits 0", async () => {
    const { tools } = fakeTools({ mypy: { code: 0, stdout: "" } });
    expect(await check(target({ categories: only("typecheck") }), tools)).toEqual([]);
  });

  it("reports a failing run without recognisable errors as a failed run", async () => {
    const { tools } = fakeTools({ mypy: { code: 2, stderr: "mypy: can't read file 'x': No such file" } });
    const findings = await check(target({ categories: only("typecheck") }), tools);
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });
});

describe("python checker: pyright", () => {
  const pyrightTarget = (over: Partial<CodeTarget> = {}) =>
    target({ effective: { "typecheck.tool": "pyright" }, categories: only("typecheck"), ...over });

  it("runs pyright when typecheck.tool is pyright and reads its JSON output", async () => {
    const stdout = JSON.stringify({
      version: "1.1.405",
      generalDiagnostics: [
        {
          file: abs("api", "src", "app.py"),
          severity: "error",
          message: 'Type "str" is not assignable to declared type "int"',
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
          rule: "reportAssignmentType",
        },
        {
          file: abs("api", "src", "app.py"),
          severity: "warning",
          message: "Import cycle",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        { file: abs("api", "src", "app.py"), severity: "information", message: "FYI", range: { start: { line: 0 } } },
      ],
      summary: { errorCount: 1, warningCount: 1 },
    });
    const { tools, calls } = fakeTools({ pyright: { code: 1, stdout } });
    const findings = await check(pyrightTarget({ files: ["src/app.py"] }), tools);
    expect(calls).toEqual([{ language: "python", tool: "pyright", dir: "api/", args: ["--outputjson"] }]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "pyright/reportAssignmentType",
        message: 'Type "str" is not assignable to declared type "int"',
        component: "api/ (Python)",
        file: "api/src/app.py",
        line: 3,
        fix: "手動修正型別錯誤",
        fixable: false,
      },
      expect.objectContaining({ level: "hint", rule: "pyright/warning", file: "api/src/app.py", line: 1 }),
    ]);
  });

  it("reports a pyright crash (no JSON) as a failed run", async () => {
    const { tools } = fakeTools({ pyright: { code: 3, stdout: "", stderr: "Config file could not be parsed" } });
    const findings = await check(pyrightTarget(), tools);
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });
});

describe("python checker: categories", () => {
  it("runs Ruff lint, Ruff format and the type checker for a full check", async () => {
    const { tools, calls } = fakeTools({ "ruff check": { stdout: "[]" } });
    expect(await check(target(), tools)).toEqual([]);
    expect(calls.map((c) => `${c.tool} ${c.args?.[0] ?? ""}`)).toEqual([
      "ruff check",
      "ruff format",
      "mypy --no-pretty",
    ]);
  });
});
