import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";
import type { ToolRequest, ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

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

/** What Ruff is given to check: the text on stdin, or the `.py` files named in its arguments, read from `dir`. */
function ruffInputs(req: ToolRequest, dir: string): { file: string; text: string }[] {
  const args = req.args ?? [];
  if (req.stdin !== undefined) {
    return [{ file: args[args.indexOf("--stdin-filename") + 1] ?? "app.py", text: req.stdin }];
  }
  return args.filter((a) => a.endsWith(".py")).map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
}

/** Ruff reports F401 for any file (on stdin or on disk under `dir`) containing "import os"; all else is clean. */
function fakeTools(dir = "C:/x") {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      if (req.args?.[0] !== "check") return Promise.resolve({ code: 0, stdout: req.stdin ?? "", stderr: "" });
      const diagnostics = ruffInputs(req, dir)
        .filter((input) => input.text.includes("import os"))
        .map(({ file }) => ({ code: "F401", message: "unused", filename: join(dir, file), location: { row: 1 } }));
      const stdout = JSON.stringify(diagnostics);
      return Promise.resolve({ code: diagnostics.length > 0 ? 1 : 0, stdout, stderr: "" });
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
    write("app.py", "x = 3\n");
    write("other.py", "import os\n");
    const { tools, calls } = fakeTools(dir);
    const r = await cli(dir, ["check", "--staged", "--format", "json"], tools);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { findings: { rule: string; file?: string }[] };
    expect(report.findings.map((f) => f.file)).toEqual(["app.py"]);
    expect(calls.find((c) => c.args?.[0] === "check")?.stdin).toBe("import os\n");
  });

  describe("how many tool runs the staged files cost (#205)", () => {
    const ruffChecks = (calls: readonly ToolRequest[]) =>
      calls
        .filter((c) => c.tool === "ruff" && c.args?.[0] === "check")
        .map((c) => ({ files: c.args?.filter((a) => a.endsWith(".py")), stdin: c.stdin }));
    const findingFiles = (out: string) =>
      (JSON.parse(out) as { findings: { file?: string }[] }).findings.map((f) => f.file);

    it("checks every staged file that is the same in the working tree in one run, and reports the same findings", async () => {
      const { dir, git, write } = repo();
      const names = ["a.py", "b.py", "c.py", "d.py"];
      for (const name of names) write(name, name === "c.py" ? "import os\n" : "x = 1\n");
      git("add", ...names);
      const { tools, calls } = fakeTools(dir);
      const r = await cli(dir, ["check", "--staged", "--format", "json"], tools);
      expect(ruffChecks(calls)).toEqual([{ files: names, stdin: undefined }]);
      expect(findingFiles(r.out)).toEqual(["c.py"]);
      expect(r.code).toBe(1);
    });

    it("still feeds the staged version of a partially staged file through stdin, next to the one run for the rest", async () => {
      const { dir, git, write } = repo();
      for (const name of ["a.py", "b.py", "c.py"]) write(name, "x = 1\n");
      write("b.py", "import os\n");
      git("add", "a.py", "b.py", "c.py");
      write("b.py", "x = 2\n");
      const { tools, calls } = fakeTools(dir);
      const r = await cli(dir, ["check", "--staged", "--format", "json"], tools);
      expect(ruffChecks(calls)).toEqual([
        { files: ["a.py", "c.py"], stdin: undefined },
        { files: ["b.py"], stdin: "import os\n" },
      ]);
      expect(findingFiles(r.out)).toEqual(["b.py"]);
    });

    it("feeds the staged LF version through stdin when the working tree holds it with CRLF", async () => {
      const { dir, git, write } = repo();
      write(".gitattributes", "* text=auto\n");
      write("a.py", "x = 2\n");
      git("add", ".gitattributes", "a.py");
      write("a.py", "x = 2\r\n");
      expect(git("diff", "--name-only")).toBe("");
      const { tools, calls } = fakeTools(dir);
      await cli(dir, ["check", "--staged"], tools);
      expect(ruffChecks(calls)).toEqual([{ files: ["a.py"], stdin: "x = 2\n" }]);
    });

    it("feeds the staged version through stdin when the file was deleted from the working tree after staging", async () => {
      const { dir, git, write } = repo();
      write("a.py", "import os\n");
      git("add", "a.py");
      rmSync(join(dir, "a.py"));
      const { tools, calls } = fakeTools(dir);
      const r = await cli(dir, ["check", "--staged", "--format", "json"], tools);
      expect(ruffChecks(calls)).toEqual([{ files: ["a.py"], stdin: "import os\n" }]);
      expect(findingFiles(r.out)).toEqual(["a.py"]);
    });
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
