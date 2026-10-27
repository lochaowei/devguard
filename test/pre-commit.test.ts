import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreCommit } from "../src/hooks/pre-commit.ts";
import { ToolMissingError, type ToolRequest, type ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo with a committed Python component; Ruff and mypy are faked (not installed on this machine). */
function repo(): { dir: string; git: (...args: string[]) => string; write: (name: string, text: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "devguard-precommit-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
  };
  write(".devguard.yaml", "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n");
  write("app.py", "x = 1\n");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "setup");
  return { dir, git, write };
}

/** Ruff reports F401 for any stdin containing "import os"; everything else is clean. */
function fakeTools() {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const unused = req.stdin?.includes("import os") === true && req.args?.[0] === "check";
      const filename = join("C:", "x", "app.py");
      const stdout =
        req.args?.[0] === "check"
          ? JSON.stringify(unused ? [{ code: "F401", message: "unused", filename, location: { row: 1 } }] : [])
          : (req.stdin ?? "");
      return Promise.resolve({ code: unused ? 1 : 0, stdout, stderr: "" });
    },
  };
  return { tools, calls };
}

async function preCommit(dir: string, tools: ToolRunner) {
  let out = "";
  const code = await runPreCommit({ cwd: dir, today: TODAY, tools, write: (t) => (out += t) });
  return { code, out };
}

describe("runPreCommit (SPEC §7.4)", () => {
  it("blocks with the install command when a tool is not installed", async () => {
    const { dir, git, write } = repo();
    write("app.py", "x = 2\n");
    git("add", "app.py");
    const tools: ToolRunner = { run: () => Promise.reject(new ToolMissingError("找不到 ruff", "uv sync")) };
    const { code, out } = await preCommit(dir, tools);
    expect(code).toBe(1);
    expect(out).toContain("找不到 ruff");
    expect(out).toContain("uv sync");
  });

  it("skips staged files the declaration ignores", async () => {
    const { dir, git, write } = repo();
    write(
      ".devguard.yaml",
      "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\nignore: [gen.py]\n",
    );
    git("add", ".devguard.yaml");
    git("commit", "-q", "--no-verify", "-m", "ignore");
    write("gen.py", "import os\n");
    git("add", "gen.py");
    const { tools, calls } = fakeTools();
    expect((await preCommit(dir, tools)).code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("leaves ignored files out of the partially-staged warning (#35)", async () => {
    const { dir, git, write } = repo();
    write(
      ".devguard.yaml",
      "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\nignore: [gen.py]\n",
    );
    write("gen.py", "a = 1\n");
    git("add", ".");
    git("commit", "-q", "--no-verify", "-m", "ignore");
    for (const name of ["gen.py", "app.py"]) {
      write(name, "b = 2\n");
      git("add", name);
      write(name, "c = 3\n");
    }
    const { out } = await preCommit(dir, fakeTools().tools);
    expect(out).toContain("注意：app.py 有未 staged 的修改");
    expect(out).not.toContain("gen.py");
  });

  it("passes when nothing is staged, without running any tool", async () => {
    const { dir } = repo();
    const { tools, calls } = fakeTools();
    expect((await preCommit(dir, tools)).code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("checks the staged version, names the working-tree tools for a partially staged file and prints the fix", async () => {
    const { dir, git, write } = repo();
    write("app.py", "import os\n");
    git("add", "app.py");
    write("app.py", "x = 2\n");
    const { tools, calls } = fakeTools();
    const { code, out } = await preCommit(dir, tools);
    expect(code).toBe(1);
    expect(calls.find((c) => c.args?.[0] === "check")?.stdin).toBe("import os\n");
    expect(calls.some((c) => c.tool === "mypy")).toBe(true);
    expect(out).toContain("mypy");
    expect(out).toContain("工作目錄版本");
    expect(out).toContain("devguard fix --code ");
  });

  it("says nothing about the working tree when staged and working versions match", async () => {
    const { dir, git, write } = repo();
    write("app.py", "y = 1\n");
    git("add", "app.py");
    const { code, out } = await preCommit(dir, fakeTools().tools);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("runs the dependency rules only when a dependency file is staged", async () => {
    const { dir, git, write } = repo();
    write("pyproject.toml", '[project]\nname = "x"\n');
    git("add", "pyproject.toml");
    const { code, out } = await preCommit(dir, fakeTools().tools);
    expect(code).toBe(1);
    expect(out).toContain("deps/lockfile-missing");
    expect(out).not.toContain("devguard fix --code");
  });

  it("fails loudly when git does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devguard-nogit-"));
    dirs.push(dir);
    await expect(preCommit(dir, fakeTools().tools)).rejects.toThrow("git diff");
  });
});
