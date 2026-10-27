import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";
import type { ToolRequest, ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo with a committed Python component. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "devguard-staged-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
  };
  write(".devguard.yaml", "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n");
  write("app.py", "x = 1\n");
  write("other.py", "y = 1\n");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "setup");
  return { dir, git, write };
}

/** Ruff reports F401 for any stdin containing "import os"; everything else is clean. */
function fakeTools(dir = "C:/x") {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const unused = req.stdin?.includes("import os") === true && req.args?.[0] === "check";
      const filename = join(dir, "app.py");
      const stdout =
        req.args?.[0] === "check"
          ? JSON.stringify(unused ? [{ code: "F401", message: "unused", filename, location: { row: 1 } }] : [])
          : (req.stdin ?? "");
      return Promise.resolve({ code: unused ? 1 : 0, stdout, stderr: "" });
    },
  };
  return { tools, calls };
}

/** Runs the CLI; without `tools`, the real tools run. */
async function cli(dir: string, args: string[], tools: ToolRunner | undefined) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: dir,
    today: TODAY,
    ...(tools ? { tools } : {}),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    stdin: () => Promise.resolve(""),
  });
  return { code, out, err };
}

describe("devguard check --staged (SPEC §3.2): the pre-commit hook's checks", () => {
  it("checks only the staged files, in their staged version, in the chosen format", async () => {
    const { dir, git, write } = repo();
    write("app.py", "import os\n");
    git("add", "app.py");
    write("other.py", "import os\n");
    const { tools, calls } = fakeTools(dir);
    const r = await cli(dir, ["check", "--staged", "--format", "json"], tools);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { findings: { rule: string; file?: string }[] };
    expect(report.findings.map((f) => f.file)).toEqual(["app.py"]);
    expect(calls.find((c) => c.args?.[0] === "check")?.stdin).toBe("import os\n");
  });

  describe(
    "staged files besides the sources of a TypeScript component, with the real ESLint and Prettier (#55, #56)",
    {
      timeout: 120_000,
    },
    () => {
      /** A TypeScript component at the root that borrows this repo's node_modules; `staged` is added on top. */
      function typescriptRepo(staged: Record<string, string>) {
        const { dir, git, write } = repo();
        symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
        write(".gitignore", "node_modules\n");
        write(".devguard.yaml", "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n");
        write("eslint.config.js", 'export default [{ rules: { "no-unused-vars": "error" } }];\n');
        write("package.json", '{ "type": "module" }\n');
        git("add", ".");
        git("commit", "-q", "--no-verify", "-m", "typescript");
        for (const [name, text] of Object.entries(staged)) write(name, text);
        git("add", ...Object.keys(staged));
        return dir;
      }
      const brief = (out: string) =>
        (JSON.parse(out) as { findings: { rule: string; file?: string }[] }).findings.map(
          (f) => `${f.rule} ${f.file ?? ""}`,
        );

      it("reports ESLint findings for a staged .mjs and exits 1", async () => {
        const dir = typescriptRepo({ "tool.mjs": "export const used = 1;\nconst unused = 2;\n" });
        const r = await cli(dir, ["check", "--staged", "--format", "json"], undefined);
        expect(brief(r.out)).toEqual(["eslint/no-unused-vars tool.mjs"]);
        expect(r.code).toBe(1);
      });

      it("reports a format finding for a staged .prettierrc that Prettier would change", async () => {
        const dir = typescriptRepo({ ".prettierrc": "printWidth:    120\n" });
        const r = await cli(dir, ["check", "--staged", "--format", "json"], undefined);
        expect(brief(r.out)).toEqual(["prettier/format .prettierrc"]);
        expect(r.code).toBe(1);
      });

      it("reports nothing, and no tool failure, for staged files no tool handles", async () => {
        const dir = typescriptRepo({ LICENSE: "MIT   License\n", "notes.txt": "anything    goes\n" });
        const r = await cli(dir, ["check", "--staged", "--format", "json"], undefined);
        expect(brief(r.out)).toEqual([]);
        expect(r.code).toBe(0);
      });

      it("reports nothing for a staged blank file no tool handles", async () => {
        const dir = typescriptRepo({ LICENSE: "\n" });
        const r = await cli(dir, ["check", "--staged", "--format", "json"], undefined);
        expect(brief(r.out)).toEqual([]);
        expect(r.code).toBe(0);
      });

      it("still reports a staged blank file that Prettier formats to nothing", async () => {
        const dir = typescriptRepo({ "empty.mjs": "\n" });
        const r = await cli(dir, ["check", "--staged", "--format", "json"], undefined);
        expect(brief(r.out)).toEqual(["prettier/format empty.mjs"]);
        expect(r.code).toBe(1);
      });
    },
  );

  it("passes when nothing is staged, without running any tool", async () => {
    const { dir } = repo();
    const { tools, calls } = fakeTools();
    const r = await cli(dir, ["check", "--staged"], tools);
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("warns on stderr about checks that read the working tree of a partially staged file", async () => {
    const { dir, git, write } = repo();
    write("app.py", "x = 2\n");
    git("add", "app.py");
    write("app.py", "x = 3\n");
    const r = await cli(dir, ["check", "--staged"], fakeTools().tools);
    expect(r.code).toBe(0);
    expect(r.err).toContain("工作目錄版本");
  });

  it("cannot be combined with files, --full or --only", async () => {
    const { dir } = repo();
    for (const extra of [["app.py"], ["--full"], ["--only", "lint"]]) {
      const r = await cli(dir, ["check", "--staged", ...extra], fakeTools().tools);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--staged");
    }
  });
});
