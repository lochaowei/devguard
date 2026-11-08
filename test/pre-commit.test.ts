import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreCommit } from "../src/hooks/pre-commit.ts";
import { ToolMissingError, type ToolRequest, type ToolResult, type ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

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

interface FakeOptions {
  /** Ruff offers a safe fix for F401, so `devguard fix --code` resolves it. */
  safeFix?: boolean;
  /** Extra files Ruff reports a safe-fix F401 for, whatever it is asked to check. */
  ruffAlso?: string[];
  /** mypy's error lines; mypy passes when there are none. */
  mypy?: string[];
}

const unusedImport = (filename: string, safe: boolean) => ({
  code: "F401",
  message: "unused",
  filename,
  location: { row: 1 },
  fix: safe ? { applicability: "safe" } : null,
});

/** `ruff check` on one staged file's stdin: F401 when it contains "import os", plus `ruffAlso`. */
function ruffCheck(req: ToolRequest, options: FakeOptions): ToolResult {
  const args = req.args ?? [];
  const file = args[args.indexOf("--stdin-filename") + 1] ?? "app.py";
  const unused = req.stdin?.includes("import os") === true;
  const diagnostics = [
    ...(unused ? [unusedImport(file, options.safeFix === true)] : []),
    ...(options.ruffAlso ?? []).map((f) => unusedImport(f, true)),
  ];
  return { code: diagnostics.length > 0 ? 1 : 0, stdout: JSON.stringify(diagnostics), stderr: "" };
}

/** Ruff reports F401 for any stdin containing "import os"; mypy prints the given lines; everything else is clean. */
function fakeTools(options: FakeOptions = {}) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const mypy = options.mypy ?? [];
      if (req.tool === "mypy")
        return Promise.resolve({ code: mypy.length > 0 ? 1 : 0, stdout: mypy.join("\n"), stderr: "" });
      if (req.args?.[0] === "check") return Promise.resolve(ruffCheck(req, options));
      return Promise.resolve({ code: 0, stdout: req.stdin ?? "", stderr: "" });
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
    const { tools, calls } = fakeTools({ safeFix: true });
    const { code, out } = await preCommit(dir, tools);
    expect(code).toBe(1);
    expect(calls.find((c) => c.args?.[0] === "check")?.stdin).toBe("import os\n");
    expect(calls.some((c) => c.tool === "mypy")).toBe(true);
    expect(out).toContain("mypy");
    expect(out).toContain("工作目錄版本");
    expect(out).toContain("修正程式碼：devguard fix --code app.py\n");
  });

  it("prints no fix command when only the type checker finds errors, and still blocks (#123)", async () => {
    const { dir, git, write } = repo();
    write("app.py", "y = 1\n");
    git("add", "app.py");
    const mypy = ["app.py:1: error: Bad type  [assignment]", "other.py:3: error: Bad type  [assignment]"];
    const { code, out } = await preCommit(dir, fakeTools({ mypy }).tools);
    expect(code).toBe(1);
    expect(out).toContain("mypy/assignment");
    expect(out).not.toContain("修正程式碼：");
  });

  it("lists the staged file with a fixable finding, not an unstaged file with type errors (#123)", async () => {
    const { dir, git, write } = repo();
    write("app.py", "import os\n");
    git("add", "app.py");
    const mypy = ["other.py:3: error: Bad type  [assignment]"];
    const { code, out } = await preCommit(dir, fakeTools({ safeFix: true, mypy }).tools);
    expect(code).toBe(1);
    expect(out).toContain("修正程式碼：devguard fix --code app.py\n");
  });

  it("leaves out unstaged files even when their findings are fixable (#123)", async () => {
    const { dir, git, write } = repo();
    write("app.py", "import os\n");
    git("add", "app.py");
    const { code, out } = await preCommit(dir, fakeTools({ safeFix: true, ruffAlso: ["other.py"] }).tools);
    expect(code).toBe(1);
    expect(out).toContain("other.py:1");
    expect(out).toContain("修正程式碼：devguard fix --code app.py\n");
  });

  it("prints no fix command when the staged file's findings all need a manual fix (#123)", async () => {
    const { dir, git, write } = repo();
    write("app.py", "import os\n");
    git("add", "app.py");
    const { code, out } = await preCommit(dir, fakeTools().tools);
    expect(code).toBe(1);
    expect(out).toContain("ruff/F401");
    expect(out).not.toContain("修正程式碼：");
  });

  it("names Biome lint, which has no usable stdin mode, for a partially staged Biome file (#120)", async () => {
    const { dir, git, write } = repo();
    write(
      ".devguard.yaml",
      "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n    overrides:\n      lint.tool: biome\n",
    );
    write("a.ts", "export const a = 1;\n");
    git("add", ".");
    write("a.ts", "export const a = 2;\n");
    const tools: ToolRunner = {
      run: (req) => Promise.resolve({ code: 0, stdout: req.stdin ?? "", stderr: "" }),
    };
    const { code, out } = await preCommit(dir, tools);
    expect(code).toBe(0);
    expect(out).toBe(
      "注意：a.ts 有未 staged 的修改。其他檢查用的是 staged 版本，" +
        "但 biome lint、tsc 沒有可用的 stdin 模式，檢查的是工作目錄版本。\n",
    );
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
