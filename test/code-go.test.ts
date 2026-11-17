import { describe, expect, it } from "vitest";
import { goChecker } from "../src/code/go.ts";
import type { CodeCategory, CodeTarget } from "../src/code/types.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (...parts: string[]) => [CWD, ...parts].join(process.platform === "win32" ? "\\" : "/");

function fakeTools(reply: Partial<ToolResult> = {}) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      return Promise.resolve({ code: 0, stdout: '{"Issues":[]}', stderr: "", ...reply });
    },
  };
  return { tools, calls };
}

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "svc/ (Go)",
    dir: "svc/",
    language: "go",
    effective: { "lint.tool": "golangci-lint", "tools.golangci-lint": ">=2.12,<3" },
    categories: new Set<CodeCategory>(["lint", "format", "typecheck"]),
    ...over,
  };
}

const only = (...c: CodeCategory[]) => new Set<CodeCategory>(c);

function check(t: CodeTarget, tools: ToolRunner) {
  return goChecker.check(t, { cwd: CWD, tools, readText: () => Promise.resolve(undefined) });
}

function issue(linter: string, file: string, line: number, text: string, severity = "") {
  return { FromLinter: linter, Text: text, Severity: severity, Pos: { Filename: file, Line: line, Column: 1 } };
}

const output = (...issues: unknown[]) => JSON.stringify({ Issues: issues, Report: {} });

describe("go checker: golangci-lint", () => {
  it("runs golangci-lint on the whole component and turns issues into findings", async () => {
    const stdout = output(
      issue("errcheck", abs("svc", "main.go"), 12, "Error return value is not checked"),
      issue("revive", abs("svc", "pkg", "a.go"), 3, "exported function should have comment", "warning"),
    );
    const { tools, calls } = fakeTools({ code: 1, stdout });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(calls).toEqual([
      expect.objectContaining({
        language: "go",
        tool: "golangci-lint",
        dir: "svc/",
        range: ">=2.12,<3",
        args: [
          "run",
          "--output.json.path=stdout",
          "--show-stats=false",
          "--path-mode=abs",
          "--max-same-issues=0",
          "--max-issues-per-linter=0",
          "--allow-serial-runners",
          "./...",
        ],
      }),
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "golangci-lint/errcheck",
        message: "Error return value is not checked",
        component: "svc/ (Go)",
        file: "svc/main.go",
        line: 12,
        column: 1,
        fix: "依 golangci-lint 訊息手動修改",
        fixable: false,
      },
      expect.objectContaining({ level: "hint", rule: "golangci-lint/revive", file: "svc/pkg/a.go", line: 3 }),
    ]);
  });
});

describe("go checker: file arguments", () => {
  it("checks the packages of the given files and reports only those files", async () => {
    const stdout = output(
      issue("errcheck", abs("svc", "pkg", "a.go"), 2, "unchecked"),
      issue("errcheck", abs("svc", "pkg", "other.go"), 5, "unchecked"),
      issue("errcheck", abs("svc", "main.go"), 8, "unchecked"),
    );
    const { tools, calls } = fakeTools({ code: 1, stdout });
    const files = ["pkg/a.go", "main.go", "pkg/b.go"];
    const findings = await check(target({ categories: only("lint"), files }), tools);
    expect(calls.map((c) => c.args?.filter((a) => !a.startsWith("-")).slice(1))).toEqual([["./pkg", "."]]);
    expect(findings.map((f) => f.file)).toEqual(["svc/pkg/a.go", "svc/main.go"]);
  });

  it("does not run when none of the files is Go source", async () => {
    const { tools, calls } = fakeTools();
    expect(await check(target({ files: ["go.mod", "README.md"] }), tools)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("go checker: failures", () => {
  it("reports a crashed or unreadable run as a failed run", async () => {
    for (const reply of [
      { code: 3, stderr: "can't load config" },
      { code: 1, stdout: "not json" },
    ]) {
      const findings = await check(target(), fakeTools(reply).tools);
      expect(findings).toEqual([expect.objectContaining({ rule: "code/tool-failed", component: "svc/ (Go)" })]);
    }
  });
});

describe("go checker: categories", () => {
  const issues = [
    issue("gofumpt", abs("svc", "main.go"), 4, "File is not properly formatted"),
    issue("goimports", abs("svc", "pkg", "a.go"), 1, "File is not properly formatted"),
    issue("typecheck", abs("svc", "main.go"), 9, "undefined: foo"),
    issue("govet", abs("svc", "main.go"), 7, "printf: bad verb"),
  ];
  const stdout = output(...issues);

  it("reports gofumpt and goimports problems as format findings", async () => {
    const { tools } = fakeTools({ code: 1, stdout });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(findings).toEqual([
      expect.objectContaining({ rule: "golangci-lint/gofumpt", file: "svc/main.go", line: 4 }),
      expect.objectContaining({ rule: "golangci-lint/goimports", file: "svc/pkg/a.go", line: 1 }),
    ]);
  });

  it("keeps lint, format and type errors apart for --only", async () => {
    const rulesFor = async (...c: CodeCategory[]) =>
      (await check(target({ categories: only(...c) }), fakeTools({ code: 1, stdout }).tools)).map((f) => f.rule);
    expect(await rulesFor("lint")).toEqual(["golangci-lint/govet"]);
    expect(await rulesFor("typecheck")).toEqual(["golangci-lint/typecheck"]);
    expect(await rulesFor("lint", "format", "typecheck")).toHaveLength(4);
  });

  it("marks formatter problems and issues with a suggested fix as fixable by devguard fix --code", async () => {
    const withFix = {
      ...issue("whitespace", abs("svc", "b.go"), 2, "unnecessary leading newline"),
      SuggestedFixes: [{}],
    };
    const v1Fix = { ...issue("misspell", abs("svc", "c.go"), 5, "misspelling"), Replacement: { NewLines: ["x"] } };
    const { tools } = fakeTools({ code: 1, stdout: output(...issues, withFix, v1Fix) });
    const findings = await check(target(), tools);
    expect(findings.map((f) => [f.rule, f.fixable])).toEqual([
      ["golangci-lint/gofumpt", true],
      ["golangci-lint/goimports", true],
      ["golangci-lint/typecheck", false],
      ["golangci-lint/govet", false],
      ["golangci-lint/whitespace", true],
      ["golangci-lint/misspell", true],
    ]);
    expect(findings.find((f) => f.rule === "golangci-lint/typecheck")?.fix).toBe("手動修正型別錯誤");
  });

  it("runs golangci-lint once for all categories", async () => {
    const { tools, calls } = fakeTools();
    await check(target(), tools);
    expect(calls).toHaveLength(1);
  });
});

describe("go checker: staged files (SPEC §7.4)", () => {
  /** `run` reports a gofumpt and an errcheck issue in main.go on disk; `fmt --stdin` collapses "func  f". */
  function tools() {
    const calls: ToolRequest[] = [];
    const runner: ToolRunner = {
      run(req) {
        calls.push(req);
        if (req.args?.[0] === "fmt") {
          const formatted = (req.stdin ?? "").replace("func  f", "func f");
          return Promise.resolve({ code: 0, stdout: formatted, stderr: "" });
        }
        const stdout = output(
          issue("gofumpt", abs("svc", "main.go"), 1, "File is not properly formatted"),
          issue("errcheck", abs("svc", "main.go"), 4, "Error return value is not checked"),
        );
        return Promise.resolve({ code: 1, stdout, stderr: "" });
      },
    };
    return { runner, calls };
  }

  const stagedCheck = (runner: ToolRunner, staged: Record<string, string>) =>
    goChecker.check(target({ files: ["main.go"] }), {
      cwd: CWD,
      tools: runner,
      readText: () => Promise.resolve(undefined),
      staged: (path) => Promise.resolve(staged[path]),
    });

  it("checks the staged version's format through `golangci-lint fmt --stdin`, not the working tree's", async () => {
    const { runner, calls } = tools();
    const clean = await stagedCheck(runner, { "svc/main.go": "package x\n" });
    expect(clean.map((f) => f.rule)).toEqual(["golangci-lint/errcheck"]);
    const fmt = calls.find((c) => c.args?.[0] === "fmt");
    expect(fmt).toMatchObject({ tool: "golangci-lint", dir: "svc/", args: ["fmt", "--stdin"], stdin: "package x\n" });

    const messy = await stagedCheck(tools().runner, { "svc/main.go": "package x\n\nfunc  f() {}\n" });
    expect(messy.map((f) => [f.rule, f.file, f.line])).toEqual([
      ["golangci-lint/errcheck", "svc/main.go", 4],
      ["golangci-lint/fmt", "svc/main.go", 3],
    ]);
  });
});

describe("go checker: staged files identical to the working tree share one `fmt --diff` (#216)", () => {
  const messy = "package x\n\nfunc  f() {}\n";
  const clean = "package x\n\nfunc f() {}\n";

  /** A fake `golangci-lint fmt --diff <files>`: prints a gofmt-style diff for each file read from `disk` that is messy. */
  function runner(disk: Record<string, string>) {
    const calls: ToolRequest[] = [];
    const tools: ToolRunner = {
      run(req) {
        calls.push(req);
        const args = req.args ?? [];
        if (args[0] === "fmt" && args[1] === "--diff") {
          const diffs = args
            .slice(2)
            .filter((f) => disk[`${req.dir}${f}`]?.includes("func  f"))
            .map(
              (f) =>
                `diff ${f}.orig ${f}\n--- ${f}.orig\n+++ ${f}\n@@ -1,3 +1,3 @@\n package x\n \n-func  f() {}\n+func f() {}\n`,
            );
          return Promise.resolve({ code: diffs.length > 0 ? 1 : 0, stdout: diffs.join(""), stderr: "" });
        }
        if (args[0] === "fmt") {
          return Promise.resolve({ code: 0, stdout: (req.stdin ?? "").replace("func  f", "func f"), stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: '{"Issues":[]}', stderr: "" });
      },
    };
    return { tools, calls };
  }

  const run = (files: string[], disk: Record<string, string>, staged: Record<string, string>) => {
    const { tools, calls } = runner(disk);
    const findings = goChecker.check(target({ files }), {
      cwd: CWD,
      tools,
      readText: (p) => Promise.resolve(disk[p]),
      staged: (p) => Promise.resolve(staged[p]),
    });
    return findings.then((f) => ({ findings: f, calls }));
  };

  const fmtCalls = (calls: ToolRequest[]) => calls.filter((c) => c.args?.[0] === "fmt");

  it("uses a constant number of golangci-lint fmt calls for 25 fully staged files", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${String(i)}.go`);
    const content = Object.fromEntries(names.map((n) => [`svc/${n}`, clean]));
    const { findings, calls } = await run(names, content, content);
    expect(findings).toEqual([]);
    expect(fmtCalls(calls)).toHaveLength(1);
    expect(fmtCalls(calls)[0]?.args).toEqual(["fmt", "--diff", ...names]);
  });

  it("reports a misformatted file once, at the first differing line", async () => {
    const content = { "svc/a.go": clean, "svc/b.go": messy };
    const { findings, calls } = await run(["a.go", "b.go"], content, content);
    expect(fmtCalls(calls)).toHaveLength(1);
    expect(findings.map((f) => [f.rule, f.file, f.line])).toEqual([["golangci-lint/fmt", "svc/b.go", 3]]);
  });

  it("still judges a partially staged file by its staged content, through stdin", async () => {
    const disk = { "svc/a.go": messy, "svc/b.go": clean };
    const staged = { "svc/a.go": clean, "svc/b.go": clean };
    const { findings, calls } = await run(["a.go", "b.go"], disk, staged);
    expect(findings).toEqual([]);
    const fmt = fmtCalls(calls);
    expect(fmt.map((c) => c.args)).toEqual([
      ["fmt", "--diff", "b.go"],
      ["fmt", "--stdin"],
    ]);
    expect(fmt[1]?.stdin).toBe(clean);
  });

  it("reports a tool failure when fmt --diff crashes", async () => {
    const tools: ToolRunner = {
      run: (req) =>
        Promise.resolve(
          req.args?.[0] === "fmt"
            ? { code: 3, stdout: "", stderr: "boom" }
            : { code: 0, stdout: '{"Issues":[]}', stderr: "" },
        ),
    };
    const content = { "svc/a.go": messy };
    const findings = await goChecker.check(target({ files: ["a.go"] }), {
      cwd: CWD,
      tools,
      readText: (p) => Promise.resolve(content[p as keyof typeof content]),
      staged: (p) => Promise.resolve(content[p as keyof typeof content]),
    });
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });
});
