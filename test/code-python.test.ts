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
        fix: "依 Ruff 訊息手動修改",
        fixable: false,
      },
      expect.objectContaining({ level: "error", rule: "ruff/syntax-error", file: "api/src/broken.py", line: 4 }),
    ]);
  });

  it("marks only diagnostics with a safe Ruff fix as fixable by devguard fix --code", async () => {
    const diagnostic = (code: string, fix: unknown) => ({
      code,
      message: code,
      filename: abs("api", "a.py"),
      location: { row: 1, column: 1 },
      fix,
    });
    const stdout = JSON.stringify([
      diagnostic("F401", { applicability: "safe", message: "Remove unused import", edits: [] }),
      diagnostic("B006", { applicability: "unsafe", message: "Replace with None", edits: [] }),
      diagnostic("E501", null),
    ]);
    const { tools } = fakeTools({ "ruff check": { code: 1, stdout } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(findings.map((f) => [f.rule, f.fixable, f.fix])).toEqual([
      ["ruff/F401", true, "devguard fix --code api/a.py"],
      ["ruff/B006", false, "依 Ruff 訊息手動修改"],
      ["ruff/E501", false, "依 Ruff 訊息手動修改"],
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

describe("python checker: mypy scope follows the configured files (#110)", () => {
  const MYPY_ARGS = ["--no-pretty", "--no-error-summary", "--show-error-codes", "--no-color-output"];

  /** Runs only the type check, with `files` (repo-relative path -> text) as the repo's contents. */
  async function mypyArgs(files: Record<string, string>, dir = "api/") {
    const { tools, calls } = fakeTools({});
    const readText = (path: string) => Promise.resolve(files[path]);
    await pythonChecker.check(target({ dir, categories: only("typecheck") }), { cwd: CWD, tools, readText });
    return calls.map((c) => c.args);
  }

  it("passes no path when pyproject.toml's [tool.mypy] sets files", async () => {
    const pyproject = '[tool.mypy]\nstrict = true\nfiles = ["src"]\n';
    expect(await mypyArgs({ "api/pyproject.toml": pyproject })).toEqual([MYPY_ARGS]);
  });

  it("checks the whole component when the mypy settings set no files, or there are none", async () => {
    expect(await mypyArgs({ "api/pyproject.toml": "[tool.mypy]\nstrict = true\n" })).toEqual([[...MYPY_ARGS, "."]]);
    expect(await mypyArgs({})).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("treats an empty files setting as none", async () => {
    expect(await mypyArgs({ "api/pyproject.toml": "[tool.mypy]\nfiles = []\n" })).toEqual([[...MYPY_ARGS, "."]]);
    expect(await mypyArgs({ "api/mypy.ini": "[mypy]\nfiles =\n" })).toEqual([[...MYPY_ARGS, "."]]);
  });

  it.each(["mypy.ini", ".mypy.ini", "setup.cfg"])("recognises files = src, tests in %s", async (name) => {
    expect(await mypyArgs({ [`api/${name}`]: "[mypy]\nfiles = src, tests\n" })).toEqual([MYPY_ARGS]);
  });

  it("reads a files list spread over continuation lines and a comma-separated string in pyproject.toml", async () => {
    expect(
      await mypyArgs({ "api/setup.cfg": "[metadata]\nname = x\n\n[mypy]\nfiles =\n    src,\n    tests\n" }),
    ).toEqual([MYPY_ARGS]);
    expect(await mypyArgs({ "api/pyproject.toml": '[tool.mypy]\nfiles = "src, tests"\n' })).toEqual([MYPY_ARGS]);
  });

  it("uses only the first config file in mypy's order: mypy.ini, .mypy.ini, pyproject.toml, setup.cfg", async () => {
    const withFiles = "[mypy]\nfiles = src\n";
    expect(
      await mypyArgs({
        "api/mypy.ini": "[mypy]\nstrict = True\n",
        "api/.mypy.ini": withFiles,
        "api/setup.cfg": withFiles,
      }),
    ).toEqual([[...MYPY_ARGS, "."]]);
    expect(await mypyArgs({ "api/.mypy.ini": withFiles, "api/pyproject.toml": "[tool.mypy]\n" })).toEqual([MYPY_ARGS]);
    expect(await mypyArgs({ "api/pyproject.toml": "[tool.mypy]\n", "api/setup.cfg": withFiles })).toEqual([
      [...MYPY_ARGS, "."],
    ]);
  });

  it("skips pyproject.toml without [tool.mypy] and setup.cfg without [mypy], as mypy does", async () => {
    const files = {
      "api/pyproject.toml": "[tool.ruff]\nline-length = 120\n",
      "api/setup.cfg": "[mypy]\nfiles = src\n",
    };
    expect(await mypyArgs(files)).toEqual([MYPY_ARGS]);
    expect(await mypyArgs({ "api/setup.cfg": "[flake8]\nmax-line-length = 120\n" })).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("stops at mypy.ini even without a [mypy] section, as mypy does", async () => {
    const files = {
      "api/mypy.ini": "[mypy-requests.*]\nignore_missing_imports = True\n",
      "api/setup.cfg": "[mypy]\nfiles = src\n",
    };
    expect(await mypyArgs(files)).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("skips a config file mypy cannot parse and keeps looking", async () => {
    expect(
      await mypyArgs({ "api/pyproject.toml": "[tool.mypy\nfiles = [", "api/setup.cfg": "[mypy]\nfiles = src\n" }),
    ).toEqual([MYPY_ARGS]);
    expect(await mypyArgs({ "api/mypy.ini": "files = src\n" })).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("skips an INI file with a duplicate section or key, which mypy's strict configparser rejects", async () => {
    const fallback = { "api/setup.cfg": "[mypy]\nstrict = True\n" };
    const duplicateSection = "[mypy]\nfiles = src\n\n[mypy]\nstrict = True\n";
    expect(await mypyArgs({ "api/mypy.ini": duplicateSection, ...fallback })).toEqual([[...MYPY_ARGS, "."]]);
    const duplicateKey = "[mypy]\nfiles = src\nFILES = tests\n";
    expect(await mypyArgs({ "api/mypy.ini": duplicateKey, ...fallback })).toEqual([[...MYPY_ARGS, "."]]);
    // Without the fallback, the skipped file's `files` must not be used either.
    expect(await mypyArgs({ "api/mypy.ini": duplicateKey })).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("looks in parent directories up to the repo root when the component has no config, as mypy does", async () => {
    expect(await mypyArgs({ "pyproject.toml": '[tool.mypy]\nfiles = ["api/src"]\n' }, "api/web/")).toEqual([MYPY_ARGS]);
    const nearer = {
      "api/web/setup.cfg": "[mypy]\nstrict = True\n",
      "pyproject.toml": '[tool.mypy]\nfiles = ["src"]\n',
    };
    expect(await mypyArgs(nearer, "api/web/")).toEqual([[...MYPY_ARGS, "."]]);
  });

  it("does not report files outside the configured files (regression for #110)", async () => {
    // Behaves like mypy: a path on the command line overrides `files`, so `.` also checks docs/conf.py.
    const calls: ToolRequest[] = [];
    const tools: ToolRunner = {
      run(req) {
        calls.push(req);
        const errors = ["src/app.py:2: error: Missing return statement  [return]"];
        if (req.args?.includes("."))
          errors.push('docs/conf.py:1: error: Need type annotation for "x"  [var-annotated]');
        return Promise.resolve({ code: 1, stdout: errors.join("\n"), stderr: "" });
      },
    };
    const readText = (path: string) =>
      Promise.resolve(path === "api/pyproject.toml" ? '[tool.mypy]\nstrict = true\nfiles = ["src"]\n' : undefined);
    const findings = await pythonChecker.check(target({ categories: only("typecheck") }), {
      cwd: CWD,
      tools,
      readText,
    });
    expect(findings.map((f) => `${f.rule} ${f.file ?? ""}`)).toEqual(["mypy/return api/src/app.py"]);
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

describe("python checker: basedpyright (#68)", () => {
  const basedTarget = () => target({ effective: { "typecheck.tool": "basedpyright" }, categories: only("typecheck") });

  it("runs basedpyright when typecheck.tool is basedpyright and reports its diagnostics", async () => {
    const stdout = JSON.stringify({
      version: "1.40.2",
      generalDiagnostics: [
        {
          file: abs("api", "src", "app.py"),
          severity: "error",
          message: 'Type of "x" is Any',
          range: { start: { line: 6, character: 0 }, end: { line: 6, character: 1 } },
          rule: "reportAny",
        },
      ],
    });
    const { tools, calls } = fakeTools({ basedpyright: { code: 1, stdout } });
    const findings = await check(basedTarget(), tools);
    expect(calls).toEqual([{ language: "python", tool: "basedpyright", dir: "api/", args: ["--outputjson"] }]);
    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        rule: "basedpyright/reportAny",
        message: 'Type of "x" is Any',
        file: "api/src/app.py",
        line: 7,
      }),
    ]);
  });

  it("passes each tool's standard range to the runner, for the install hint when it is missing", async () => {
    const effective = {
      "typecheck.tool": "basedpyright",
      "tools.ruff": ">=0.17,<1",
      "tools.basedpyright": ">=1.40,<2",
    };
    const { tools, calls } = fakeTools({ "ruff check": { stdout: "[]" }, basedpyright: { stdout: "{}" } });
    await check(target({ effective }), tools);
    expect(calls.map((c) => [c.tool, c.range])).toEqual([
      ["ruff", ">=0.17,<1"],
      ["ruff", ">=0.17,<1"],
      ["basedpyright", ">=1.40,<2"],
    ]);
  });

  it("names basedpyright among the tools that check the working tree", () => {
    expect(pythonChecker.workingTreeTools(basedTarget())).toEqual(["basedpyright"]);
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
