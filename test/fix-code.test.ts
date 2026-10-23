import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeFix } from "../src/fix/code.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-fixcode-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function session(over: Partial<Interaction> = {}) {
  const out: string[] = [];
  const io: Interaction = {
    yes: false,
    interactive: false,
    write: (t) => out.push(t),
    confirm: () => Promise.resolve(false),
    ...over,
  };
  return { io, output: () => out.join("") };
}

const decl = (dir: string, language: string) =>
  `standard: team@1.0.0\ncomponents:\n  - path: ${dir}\n    language: ${language}\n`;

type Reply = Partial<ToolResult>;

/**
 * A fake TypeScript toolchain: ESLint reports a fixable prefer-const and an unfixable no-unused-vars, Prettier lists
 * web/messy.ts; `eslint --fix` and `prettier --write` clear what they can fix. Records every request.
 */
function typescriptTools(over: { write?: Reply } = {}) {
  const calls: ToolRequest[] = [];
  const state = { eslintFixed: false, prettierFixed: false };
  const eslint = (args: readonly string[]): Reply => {
    if (args.includes("--fix")) {
      state.eslintFixed = true;
      return { code: 1 };
    }
    const unused = { ruleId: "no-unused-vars", severity: 2, message: "'x' is unused", line: 2 };
    const preferConst = { ruleId: "prefer-const", severity: 2, message: "use const", line: 2, fix: {} };
    const messages = state.eslintFixed ? [unused] : [unused, preferConst];
    return { code: 1, stdout: JSON.stringify([{ filePath: "messy.ts", messages }]) };
  };
  const prettier = (args: readonly string[]): Reply => {
    if (args.includes("--write")) {
      state.prettierFixed = true;
      return over.write ?? {};
    }
    const listing = args.includes("--list-different") && !state.prettierFixed;
    return listing ? { code: 1, stdout: "messy.ts\n" } : {};
  };
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const args = req.args ?? [];
      const r = req.tool === "eslint" ? eslint(args) : req.tool === "prettier" ? prettier(args) : {};
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...r });
    },
  };
  const fixCalls = () =>
    calls.filter((c) => c.args?.includes("--fix") || c.args?.includes("--write")).map((c) => [c.tool, c.dir, c.args]);
  return { tools, fixCalls };
}

function tsRepo() {
  return repo({ ".devguard.yaml": decl("web", "typescript"), "web/messy.ts": "let  x = 1;\n" });
}

const listFiles = () => Promise.resolve(["web/messy.ts", "web/clean.ts"]);

describe("devguard fix --code (SPEC §9.1, §9.3)", () => {
  it("--yes runs the language's fixers on the component, then re-checks and reports what is left", async () => {
    const cwd = tsRepo();
    const { tools, fixCalls } = typescriptTools();
    const { io, output } = session({ yes: true });
    const code = await runCodeFix({ cwd, today: TODAY, tools, listFiles, io });
    expect(fixCalls()).toEqual([
      ["eslint", "web/", ["--fix", "--no-warn-ignored", "."]],
      ["prettier", "web/", ["--write", "--log-level", "warn", "."]],
    ]);
    const text = output();
    expect(text).toContain("已套用");
    const report = text.slice(text.indexOf("已套用"));
    expect(report).toContain("eslint/no-unused-vars");
    expect(report).not.toContain("eslint/prefer-const");
    expect(report).not.toContain("prettier/format");
    // An unfixable error is left, so the run fails like `check` would.
    expect(code).toBe(1);
  });

  it("without --yes in a non-interactive run only previews the fixable problems and commands, and exits 1", async () => {
    const cwd = tsRepo();
    const { tools, fixCalls } = typescriptTools();
    const { io, output } = session();
    expect(await runCodeFix({ cwd, today: TODAY, tools, listFiles, io })).toBe(1);
    expect(fixCalls()).toEqual([]);
    const text = output();
    expect(text).toContain("eslint --fix --no-warn-ignored .");
    expect(text).toContain("prettier --write --log-level warn .");
    expect(text).toContain("web/messy.ts:2  use const  [eslint/prefer-const]");
    expect(text).toContain("[prettier/format]");
    expect(text).not.toContain("eslint/no-unused-vars");
    expect(text).toContain("非互動環境");
  });

  it("an interactive terminal applies only once confirmed", async () => {
    const declined = typescriptTools();
    const no = session({ interactive: true, confirm: () => Promise.resolve(false) });
    expect(await runCodeFix({ cwd: tsRepo(), today: TODAY, tools: declined.tools, listFiles, io: no.io })).toBe(1);
    expect(declined.fixCalls()).toEqual([]);

    const confirmed = typescriptTools();
    const yes = session({ interactive: true, confirm: () => Promise.resolve(true) });
    await runCodeFix({ cwd: tsRepo(), today: TODAY, tools: confirmed.tools, listFiles, io: yes.io });
    expect(confirmed.fixCalls()).toHaveLength(2);
  });

  it("fixes only the given files, relative to the component", async () => {
    const { tools, fixCalls } = typescriptTools();
    const { io } = session({ yes: true });
    const scope = { files: ["web/messy.ts"], full: false };
    await runCodeFix({ cwd: tsRepo(), today: TODAY, tools, listFiles, io, scope });
    expect(fixCalls()).toEqual([
      ["eslint", "web/", ["--fix", "--no-warn-ignored", "messy.ts"]],
      ["prettier", "web/", ["--write", "--log-level", "warn", "messy.ts"]],
    ]);
  });

  it("runs no fixer when nothing is fixable, and reports the problems left", async () => {
    const { tools, fixCalls } = typescriptTools();
    // Already formatted and lint-fixed: only the unfixable no-unused-vars is left.
    await tools.run({ language: "typescript", tool: "eslint", dir: "web/", args: ["--fix"] });
    await tools.run({ language: "typescript", tool: "prettier", dir: "web/", args: ["--write"] });
    const before = fixCalls().length;
    const { io, output } = session();
    expect(await runCodeFix({ cwd: tsRepo(), today: TODAY, tools, listFiles, io })).toBe(1);
    expect(fixCalls()).toHaveLength(before);
    expect(output()).toContain("沒有可自動修正的程式碼問題");
    expect(output()).toContain("eslint/no-unused-vars");
  });

  describe("runs each language's formatter and lint fixer", () => {
    const abs = (cwd: string, path: string) => join(cwd, path);
    const isFix = (req: ToolRequest) => {
      const args = req.args ?? [];
      const ruffFormat = req.tool === "ruff" && args[0] === "format" && !args.includes("--diff");
      return ruffFormat || args.some((a) => ["--fix", "--write", "spotless:apply", "spotlessApply"].includes(a));
    };

    /** Answers a check run; `fixed` tells whether a fixer has run already. */
    type Answer = (req: ToolRequest, cwd: string, fixed: boolean) => Reply;

    /** Tools that answer check runs through `reply` and record the fixer requests. */
    function toolsFor(reply: Answer) {
      const fixes: ToolRequest[] = [];
      const make = (cwd: string): ToolRunner => ({
        run(req) {
          const fixer = isFix(req);
          if (fixer) fixes.push(req);
          const r = fixer ? {} : reply(req, cwd, fixes.length > 0);
          return Promise.resolve({ code: 0, stdout: "", stderr: "", ...r });
        },
      });
      return { make, fixes };
    }

    async function fixWith(files: Record<string, string>, owned: string[], reply: Answer) {
      const cwd = repo(files);
      const { make, fixes } = toolsFor(reply);
      const { io, output } = session({ yes: true });
      const code = await runCodeFix({
        cwd,
        today: TODAY,
        tools: make(cwd),
        listFiles: () => Promise.resolve(owned),
        io,
      });
      return {
        code,
        output: output(),
        fixes: fixes.map((f) => ({ tool: f.tool, dir: f.dir, args: f.args, env: f.env })),
      };
    }

    it("Python: ruff check --fix, then ruff format", async () => {
      const result = await fixWith({ ".devguard.yaml": decl("api", "python") }, ["api/a.py"], (req, cwd, fixed) => {
        if (req.tool !== "ruff") return {};
        if (req.args?.[0] === "format") {
          return fixed ? {} : { code: 1, stdout: "--- a.py\n+++ a.py\n@@ -1 +1 @@\n-x=1\n+x = 1\n" };
        }
        if (fixed) return { stdout: "[]" };
        const fix = { applicability: "safe" };
        return {
          code: 1,
          stdout: JSON.stringify([
            { code: "I001", message: "unsorted", filename: abs(cwd, "api/a.py"), location: { row: 1 }, fix },
          ]),
        };
      });
      expect(result.fixes).toEqual([
        { tool: "ruff", dir: "api/", args: ["check", "--fix", "--force-exclude", "."], env: undefined },
        { tool: "ruff", dir: "api/", args: ["format", "--force-exclude", "."], env: undefined },
      ]);
      expect(result.code).toBe(0);
    });

    it("Go: golangci-lint run --fix (gofumpt and the other formatters included) with the Go mirrors", async () => {
      const files = { ".devguard.yaml": decl("svc", "go") };
      const result = await fixWith(files, ["svc/main.go"], (req, cwd, fixed) => {
        const issue = {
          FromLinter: "gofumpt",
          Text: "not formatted",
          Pos: { Filename: abs(cwd, "svc/main.go"), Line: 3 },
        };
        if (req.tool !== "golangci-lint") return {};
        return fixed ? { stdout: '{"Issues":[]}' } : { code: 1, stdout: JSON.stringify({ Issues: [issue] }) };
      });
      expect(result.fixes).toEqual([
        {
          tool: "golangci-lint",
          dir: "svc/",
          args: ["run", "--fix", "--show-stats=false", "./..."],
          env: expect.objectContaining({ GOTOOLCHAIN: "local" }) as unknown,
        },
      ]);
      expect(result.code).toBe(0);
    });

    const spotless = (req: ToolRequest): Reply =>
      req.args?.some((a) => a === "spotless:check" || a === "spotlessCheck")
        ? { code: 1, stdout: "The following files had format violations:\n    src/App.java\n        @@ -1 +1 @@\n" }
        : {};

    it("Java with Maven: spotless:apply through the wrapper", async () => {
      const files = { ".devguard.yaml": decl("app", "java"), "app/pom.xml": "<project/>" };
      const result = await fixWith(files, ["app/src/App.java"], spotless);
      expect(result.fixes).toEqual([
        { tool: "mvnw", dir: "app/", args: ["-B", "-ntp", "spotless:apply"], env: undefined },
      ]);
    });

    it("Java with Gradle: spotlessApply through the wrapper", async () => {
      const files = { ".devguard.yaml": decl("app", "java"), "app/build.gradle": "" };
      const result = await fixWith(files, ["app/src/App.java"], spotless);
      expect(result.fixes).toEqual([
        { tool: "gradlew", dir: "app/", args: ["spotlessApply", "--console=plain", "-q"], env: undefined },
      ]);
    });

    it("TypeScript with Biome: biome lint --write, then biome format --write", async () => {
      const files = {
        ".devguard.yaml": `${decl("web", "typescript")}    overrides:\n      lint.tool: biome\n`,
      };
      const result = await fixWith(files, ["web/a.ts"], (req) =>
        req.tool === "biome" && req.args?.[0] === "format"
          ? {
              code: 1,
              stdout: "::error title=format,file=a.ts,line=1,col=1::File content differs from formatting output\n",
            }
          : {},
      );
      expect(result.fixes.map((f) => [f.tool, f.args])).toEqual([
        ["biome", ["lint", "--write", "."]],
        ["biome", ["format", "--write", "."]],
      ]);
    });
  });

  it("reports a fixer that fails as a failed run", async () => {
    const { tools } = typescriptTools({ write: { code: 2, stderr: "[error] SyntaxError in messy.ts" } });
    const { io, output } = session({ yes: true });
    expect(await runCodeFix({ cwd: tsRepo(), today: TODAY, tools, listFiles, io })).toBe(1);
    expect(output()).toContain("prettier 執行失敗（exit 2）：[error] SyntaxError in messy.ts");
  });
});
