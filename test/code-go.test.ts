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

const MIRRORS = {
  "mirrors.go": "https://nexus.example.internal/repository/go-proxy/",
  "mirrors.gosumdb": "https://nexus.example.internal/repository/go-sumdb-proxy/",
};

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "svc/ (Go)",
    dir: "svc/",
    language: "go",
    effective: { "lint.tool": "golangci-lint", ...MIRRORS },
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
        args: ["run", "--output.json.path=stdout", "--show-stats=false", "--path-mode=abs", "./..."],
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
        fix: "devguard fix --code svc/main.go",
      },
      expect.objectContaining({ level: "hint", rule: "golangci-lint/revive", file: "svc/pkg/a.go", line: 3 }),
    ]);
  });

  it("runs with GOTOOLCHAIN=local and the standard's Go mirrors (SPEC §3.2, §10.2)", async () => {
    const { tools, calls } = fakeTools();
    await check(target(), tools);
    expect(calls[0]?.env).toEqual({
      GOTOOLCHAIN: "local",
      GOPROXY: "https://nexus.example.internal/repository/go-proxy/",
      GOSUMDB: "sum.golang.org https://nexus.example.internal/repository/go-sumdb-proxy/",
    });
  });

  it("leaves a mirror out when the standard has none", async () => {
    const { tools, calls } = fakeTools();
    await check(target({ effective: {} }), tools);
    expect(calls[0]?.env).toEqual({ GOTOOLCHAIN: "local" });
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
    expect(calls.map((c) => c.args?.slice(4))).toEqual([["./pkg", "."]]);
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
  const stdout = output(
    issue("gofumpt", abs("svc", "main.go"), 4, "File is not properly formatted"),
    issue("goimports", abs("svc", "pkg", "a.go"), 1, "File is not properly formatted"),
    issue("typecheck", abs("svc", "main.go"), 9, "undefined: foo"),
    issue("govet", abs("svc", "main.go"), 7, "printf: bad verb"),
  );

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

  it("runs golangci-lint once for all categories", async () => {
    const { tools, calls } = fakeTools();
    await check(target(), tools);
    expect(calls).toHaveLength(1);
  });
});
