import { describe, expect, it } from "vitest";
import type { CodeCategory, CodeTarget } from "../src/code/types.ts";
import { typescriptChecker } from "../src/code/typescript.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (...parts: string[]) => [CWD, ...parts].join(process.platform === "win32" ? "\\" : "/");

type Reply = Partial<ToolResult>;

/** A tool runner that answers by tool name and records every request. */
function fakeTools(replies: Record<string, Reply | ((req: ToolRequest) => Reply)>) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const reply = replies[req.tool] ?? {};
      const r = typeof reply === "function" ? reply(req) : reply;
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...r });
    },
  };
  return { tools, calls };
}

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "web/ (TypeScript)",
    dir: "web/",
    language: "typescript",
    effective: { "lint.tool": "eslint+prettier" },
    categories: new Set<CodeCategory>(["lint", "format", "typecheck"]),
    ...over,
  };
}

function check(t: CodeTarget, tools: ToolRunner, texts: Record<string, string> = {}) {
  return typescriptChecker.check(t, { cwd: CWD, tools, readText: (p) => Promise.resolve(texts[p]) });
}

const only = (...c: CodeCategory[]) => new Set<CodeCategory>(c);

describe("typescript checker: ESLint", () => {
  it("turns ESLint messages into findings with file, line and rule", async () => {
    const eslintOut = JSON.stringify([
      {
        filePath: abs("web", "src", "a.ts"),
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "'x' is unused.",
            line: 3,
            column: 7,
            fix: { range: [10, 20], text: "" },
          },
          { ruleId: "eqeqeq", severity: 1, message: "Expected '==='.", line: 5, column: 1 },
          { ruleId: null, severity: 2, message: "Parsing error: ';' expected.", line: 9, column: 2 },
        ],
      },
      { filePath: abs("web", "src", "b.ts"), messages: [] },
    ]);
    const { tools, calls } = fakeTools({ eslint: { code: 1, stdout: eslintOut } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(calls).toEqual([
      { language: "typescript", tool: "eslint", dir: "web/", args: ["--format", "json", "--no-warn-ignored", "."] },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "eslint/no-unused-vars",
        message: "'x' is unused.",
        component: "web/ (TypeScript)",
        file: "web/src/a.ts",
        line: 3,
        column: 7,
        fix: "devguard fix --code web/src/a.ts",
        fixable: true,
      },
      expect.objectContaining({
        level: "hint",
        rule: "eslint/eqeqeq",
        file: "web/src/a.ts",
        line: 5,
        fix: "依 ESLint 訊息手動修改",
        fixable: false,
      }),
      expect.objectContaining({ level: "error", rule: "eslint/parse-error", file: "web/src/a.ts", line: 9 }),
    ]);
  });

  it("passes only the given files, relative to the component", async () => {
    const { tools, calls } = fakeTools({ eslint: { stdout: "[]" } });
    await check(target({ categories: only("lint"), files: ["src/a.ts", "b.ts"] }), tools);
    expect(calls[0]?.args).toEqual(["--format", "json", "--no-warn-ignored", "src/a.ts", "b.ts"]);
  });

  it("splits long file lists into several runs so the command line stays short", async () => {
    const files = Array.from({ length: 400 }, (_, i) => `src/some/deeply/nested/folder/file-${String(i)}.ts`);
    const { tools, calls } = fakeTools({ eslint: { stdout: "[]" } });
    await check(target({ categories: only("lint"), files }), tools);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap((c) => c.args?.slice(3) ?? [])).toEqual(files);
    for (const c of calls) expect((c.args ?? []).join(" ").length).toBeLessThan(6000);
  });

  it("reports unreadable ESLint output as a failed run", async () => {
    const { tools } = fakeTools({ eslint: { code: 1, stdout: "not json" } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(findings.map((f) => f.rule)).toEqual(["code/tool-failed"]);
  });

  it("reports a crashed ESLint run as an error finding", async () => {
    const { tools } = fakeTools({ eslint: { code: 2, stderr: "Oops! Something went wrong!\nmore" } });
    const findings = await check(target({ categories: only("lint") }), tools);
    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        rule: "code/tool-failed",
        message: expect.stringContaining("eslint") as string,
      }),
    ]);
    expect(findings[0]?.message).toContain("Oops! Something went wrong!");
  });
});

describe("typescript checker: tsc", () => {
  it("turns type errors into findings and checks the whole component even for a file list", async () => {
    const stdout = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(10,1): error TS2345: Argument of type 'x' is not assignable",
      "  to parameter of type 'y'.",
      "",
    ].join("\r\n");
    const { tools, calls } = fakeTools({ tsc: { code: 2, stdout } });
    const findings = await check(target({ categories: only("typecheck"), files: ["src/a.ts"] }), tools);
    expect(calls).toEqual([
      { language: "typescript", tool: "tsc", dir: "web/", args: ["--noEmit", "--pretty", "false"] },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "tsc/TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        component: "web/ (TypeScript)",
        file: "web/src/a.ts",
        line: 3,
        column: 7,
        fix: "手動修正型別錯誤",
        fixable: false,
      },
      expect.objectContaining({ rule: "tsc/TS2345", file: "web/src/b.ts", line: 10 }),
    ]);
  });

  it("reports errors that belong to no file, such as a missing tsconfig.json", async () => {
    const { tools } = fakeTools({ tsc: { code: 1, stdout: "error TS5057: Cannot find a tsconfig.json file.\n" } });
    const findings = await check(target({ categories: only("typecheck") }), tools);
    expect(findings).toEqual([
      expect.objectContaining({ rule: "tsc/TS5057", message: "Cannot find a tsconfig.json file." }),
    ]);
    expect(findings[0]?.file).toBeUndefined();
  });

  it("reports a failing run without recognisable errors as a failed run", async () => {
    const { tools } = fakeTools({ tsc: { code: 1, stderr: "node: out of memory" } });
    const findings = await check(target({ categories: only("typecheck") }), tools);
    expect(findings).toEqual([expect.objectContaining({ rule: "code/tool-failed" })]);
  });

  it("passes when tsc exits 0", async () => {
    const { tools } = fakeTools({});
    expect(await check(target({ categories: only("typecheck") }), tools)).toEqual([]);
  });
});

describe("typescript checker: Biome", () => {
  const biome = target({ effective: { "lint.tool": "biome" }, categories: only("lint", "format") });

  it("runs Biome instead of ESLint and Prettier and reads its GitHub reporter output", async () => {
    const { tools, calls } = fakeTools({
      biome: (req) =>
        req.args?.[0] === "lint"
          ? {
              code: 1,
              stdout:
                "::error title=lint/suspicious/noDebugger,file=src/a.ts,line=4,endLine=4,col=3,endColumn=11::This is an unexpected use of the debugger statement.\n" +
                "::warning title=lint/style/useConst,file=src/b.ts,line=2,endLine=2,col=1,endColumn=4::Use const.\n",
            }
          : {
              code: 1,
              stdout:
                "::error title=format,file=src/c.ts,line=1,endLine=3,col=1,endColumn=2::File content differs from formatting output\n",
            },
    });
    const findings = await check(biome, tools);
    expect(calls.map((c) => [c.tool, ...(c.args ?? [])])).toEqual([
      ["biome", "lint", "--reporter=github", "--files-ignore-unknown=true", "--no-errors-on-unmatched", "."],
      ["biome", "format", "--reporter=github", "--files-ignore-unknown=true", "--no-errors-on-unmatched", "."],
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        level: "error",
        rule: "biome/lint/suspicious/noDebugger",
        file: "web/src/a.ts",
        line: 4,
        column: 3,
      }),
      expect.objectContaining({ level: "hint", rule: "biome/lint/style/useConst", file: "web/src/b.ts", line: 2 }),
      expect.objectContaining({ level: "error", rule: "biome/format", file: "web/src/c.ts", line: 1 }),
    ]);
  });

  it("checks staged files through `--stdin-file-path` and the rest on disk (SPEC §7.4)", async () => {
    const staged = "debugger;\nlet  a=1\n";
    const { tools, calls } = fakeTools({
      biome: (req) => {
        if (req.args?.[0] === "format") return { stdout: req.stdin === undefined ? "" : "debugger;\nlet a = 1;\n" };
        if (req.stdin === undefined) return {};
        // Biome echoes the code on stdout and reports on stderr when reading stdin.
        const annotation = "::error title=lint/suspicious/noDebugger,line=1,endLine=1,col=1,endColumn=9::Debugger.\n";
        return { code: 1, stdout: req.stdin, stderr: annotation };
      },
    });
    const ctx = {
      cwd: CWD,
      tools,
      readText: () => Promise.resolve(undefined),
      staged: (p: string) => Promise.resolve(p === "web/src/a.ts" ? staged : undefined),
    };
    const findings = await typescriptChecker.check({ ...biome, files: ["src/a.ts", "src/b.ts"] }, ctx);
    expect(calls.map((c) => [...(c.args ?? []), c.stdin === undefined ? "disk" : "stdin"])).toEqual([
      ["lint", "--reporter=github", "--files-ignore-unknown=true", "--no-errors-on-unmatched", "src/b.ts", "disk"],
      ["lint", "--reporter=github", "--stdin-file-path=src/a.ts", "--files-ignore-unknown=true", "stdin"],
      ["format", "--reporter=github", "--files-ignore-unknown=true", "--no-errors-on-unmatched", "src/b.ts", "disk"],
      ["format", "--stdin-file-path=src/a.ts", "--files-ignore-unknown=true", "stdin"],
    ]);
    expect(findings.map((f) => [f.rule, f.file, f.line])).toEqual([
      ["biome/lint/suspicious/noDebugger", "web/src/a.ts", 1],
      ["biome/format", "web/src/a.ts", 2],
    ]);
    expect(typescriptChecker.workingTreeTools({ ...biome, categories: only("lint", "format") })).toEqual([]);
  });

  it("reports a failing Biome run without diagnostics as a failed run", async () => {
    const { tools } = fakeTools({ biome: { code: 1, stderr: "configuration error" } });
    const findings = await check(target({ effective: { "lint.tool": "biome" }, categories: only("lint") }), tools);
    expect(findings).toEqual([expect.objectContaining({ rule: "code/tool-failed" })]);
  });
});

describe("typescript checker: Prettier", () => {
  const unformatted = "const a = 1;\nlet  b=2\n";
  const formatted = "const a = 1;\nlet b = 2;\n";

  it("reports each unformatted file at its first differing line", async () => {
    const { tools, calls } = fakeTools({
      prettier: (req) =>
        req.args?.includes("--list-different") ? { code: 1, stdout: "src\\a.ts\n" } : { code: 0, stdout: formatted },
    });
    const findings = await check(target({ categories: only("format") }), tools, { "web/src/a.ts": unformatted });
    expect(calls.map((c) => c.args)).toEqual([["--list-different", "--ignore-unknown", "."], ["src/a.ts"]]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "prettier/format",
        message: "格式不符合 Prettier",
        component: "web/ (TypeScript)",
        file: "web/src/a.ts",
        line: 2,
        fix: "devguard fix --code web/src/a.ts",
        fixable: true,
      },
    ]);
  });

  it("falls back to line 1 when the difference cannot be located", async () => {
    const { tools } = fakeTools({
      prettier: (req) => (req.args?.includes("--list-different") ? { code: 1, stdout: "a.ts\n" } : { code: 2 }),
    });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(findings).toEqual([expect.objectContaining({ rule: "prettier/format", file: "web/a.ts", line: 1 })]);
  });

  it("checks only the given files", async () => {
    const { tools, calls } = fakeTools({});
    expect(await check(target({ categories: only("format"), files: ["a.ts"] }), tools)).toEqual([]);
    expect(calls.map((c) => c.args)).toEqual([["--list-different", "--ignore-unknown", "a.ts"]]);
  });

  it("reports a Prettier error as a failed run", async () => {
    const { tools } = fakeTools({ prettier: { code: 2, stderr: "[error] Invalid configuration" } });
    const findings = await check(target({ categories: only("format") }), tools);
    expect(findings).toEqual([expect.objectContaining({ rule: "code/tool-failed" })]);
  });
});
