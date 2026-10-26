import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_HANDLERS, type HookContext } from "../src/hooks/registry.ts";
import { ToolMissingError, type ToolRequest, type ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DECL = "standard: team@1.0.0\ncomponents:\n  - path: ./api\n    language: python\n";

/** A git repo with a committed Python component in api/. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "devguard-claude-hook-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  write(".devguard.yaml", DECL);
  write("api/app.py", "x = 1\n");
  write("api/other.py", "y = 1\n");
  write("README.md", "hello\n");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "setup");
  return { dir, write };
}

/** Ruff reports F401 for every listed file containing "import os"; formatting and mypy are clean. */
function fakeTools(dir: string) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      if (req.tool === "ruff" && req.args?.[0] === "check") {
        const files = (req.args ?? []).filter((a) => a.endsWith(".py"));
        const found = files
          .filter((f) => readFileSync(join(dir, req.dir, f), "utf8").includes("import os"))
          .map((f) => ({
            code: "F401",
            message: "`os` imported but unused",
            filename: join(dir, req.dir, f),
            location: { row: 1 },
          }));
        return Promise.resolve({ code: found.length > 0 ? 1 : 0, stdout: JSON.stringify(found), stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: req.stdin ?? "", stderr: "" });
    },
  };
  return { tools, calls };
}

async function runHook(name: string, dir: string, input: unknown) {
  const { tools, calls } = fakeTools(dir);
  let stdout = "";
  let stderr = "";
  const ctx: HookContext = {
    cwd: dir,
    today: TODAY,
    tools,
    write: (t) => (stderr += t),
    stdout: (t) => (stdout += t),
    stdin: () => Promise.resolve(JSON.stringify(input)),
  };
  const handler = HOOK_HANDLERS[name];
  if (!handler) throw new Error(`no handler ${name}`);
  const code = await handler(ctx);
  return {
    code,
    stdout,
    stderr,
    calls,
    json: stdout.trim().startsWith("{") ? (JSON.parse(stdout) as Record<string, unknown>) : undefined,
  };
}

const postEdit = (dir: string, file: string) => ({
  hook_event_name: "PostToolUse",
  cwd: dir,
  tool_name: "Edit",
  tool_input: { file_path: join(dir, file) },
});

const ruffFiles = (calls: ToolRequest[]) =>
  calls
    .filter((c) => c.tool === "ruff" && c.args?.[0] === "check")
    .flatMap((c) => (c.args ?? []).filter((a) => a.endsWith(".py")));

describe("devguard hook claude-post-edit (SPEC §7.3)", () => {
  it("tells Claude which tool is missing and how to install it instead of failing the hook", async () => {
    const { dir } = repo();
    let stdout = "";
    const tools: ToolRunner = { run: () => Promise.reject(new ToolMissingError("找不到 ruff", "cd api && uv sync")) };
    const code = await HOOK_HANDLERS["claude-post-edit"]?.({
      cwd: dir,
      today: TODAY,
      tools,
      write: () => undefined,
      stdout: (t) => (stdout += t),
      stdin: () => Promise.resolve(JSON.stringify(postEdit(dir, "api/app.py"))),
    });
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as Record<string, unknown>;
    expect(json.decision).toBe("block");
    expect(json.reason).toContain("cd api && uv sync");
  });

  it("blocks with the edited file's lint problems as JSON on exit 0, checking only that file", async () => {
    const { dir, write } = repo();
    write("api/app.py", "import os\n");
    write("api/other.py", "import os\n");
    const { code, json, calls } = await runHook("claude-post-edit", dir, postEdit(dir, "api/app.py"));
    expect(code).toBe(0);
    expect(json?.decision).toBe("block");
    expect(json?.reason).toContain("api/app.py:1");
    expect(json?.reason).not.toContain("other.py");
    expect(ruffFiles(calls)).toEqual(["app.py"]);
    expect(calls.some((c) => c.tool === "mypy")).toBe(false);
  });

  it("prints nothing when the edited file is clean", async () => {
    const { dir } = repo();
    const { code, stdout } = await runHook("claude-post-edit", dir, postEdit(dir, "api/app.py"));
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("ignores a file no code check covers", async () => {
    const { dir } = repo();
    const { code, stdout, calls } = await runHook("claude-post-edit", dir, postEdit(dir, "README.md"));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
  });

  it("format-checks an edited non-source file of a TypeScript component, without linting it", async () => {
    const { dir, write } = repo();
    write(".devguard.yaml", `${DECL}  - path: ./web\n    language: typescript\n`);
    write("web/package.json", '{"name":"x"}\n');
    const calls: ToolRequest[] = [];
    const tools: ToolRunner = {
      run(req) {
        calls.push(req);
        const listing = req.args?.includes("--list-different") === true;
        return Promise.resolve({ code: listing ? 1 : 0, stdout: listing ? "package.json\n" : "{}\n", stderr: "" });
      },
    };
    let stdout = "";
    await HOOK_HANDLERS["claude-post-edit"]?.({
      cwd: dir,
      today: TODAY,
      tools,
      write: () => undefined,
      stdout: (t) => (stdout += t),
      stdin: () => Promise.resolve(JSON.stringify(postEdit(dir, "web/package.json"))),
    });
    const json = JSON.parse(stdout) as { decision: string; reason: string };
    expect(json.decision).toBe("block");
    expect(json.reason).toContain("web/package.json:1");
    expect(calls.map((c) => [c.tool, ...(c.args ?? [])])).toEqual([
      ["prettier", "--list-different", "package.json"],
      ["prettier", "package.json"],
    ]);
  });

  it("ignores a file outside the project", async () => {
    const { dir } = repo();
    const input = { ...postEdit(dir, "x"), tool_input: { file_path: join(tmpdir(), "elsewhere.py") } };
    const { stdout, calls } = await runHook("claude-post-edit", dir, input);
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
  });

  it("keeps the reason to at most 20 items and under 4,000 characters", async () => {
    const { dir, write } = repo();
    write("api/app.py", "import os\n".repeat(1));
    const many: ToolRunner = {
      run: (req) => {
        if (req.tool !== "ruff" || req.args?.[0] !== "check")
          return Promise.resolve({ code: 0, stdout: req.stdin ?? "", stderr: "" });
        const filename = join(dir, "api/app.py");
        const found = Array.from({ length: 50 }, (_, i) => ({
          code: "E501",
          message: "x".repeat(300),
          filename,
          location: { row: i + 1 },
        }));
        return Promise.resolve({ code: 1, stdout: JSON.stringify(found), stderr: "" });
      },
    };
    let stdout = "";
    const handler = HOOK_HANDLERS["claude-post-edit"];
    await handler?.({
      cwd: dir,
      today: TODAY,
      tools: many,
      write: () => undefined,
      stdout: (t) => (stdout += t),
      stdin: () => Promise.resolve(JSON.stringify(postEdit(dir, "api/app.py"))),
    });
    const { reason } = JSON.parse(stdout) as { reason: string };
    expect(reason.length).toBeLessThan(4000);
    expect(reason.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(20);
    expect(reason).toMatch(/還有 \d+ 項/);
  });
});

const stop = (dir: string, active: boolean) => ({ hook_event_name: "Stop", cwd: dir, stop_hook_active: active });

describe("devguard hook claude-stop (SPEC §7.3)", () => {
  it("lints, format-checks and type-checks every file changed since the last commit, including new ones", async () => {
    const { dir, write } = repo();
    write("api/app.py", "import os\n");
    write("api/new.py", "import os\n");
    const { code, json, calls } = await runHook("claude-stop", dir, stop(dir, false));
    expect(code).toBe(0);
    expect(json?.decision).toBe("block");
    expect(json?.reason).toContain("api/app.py");
    expect(json?.reason).toContain("api/new.py");
    expect(ruffFiles(calls).sort()).toEqual(["app.py", "new.py"]);
    expect(calls.some((c) => c.tool === "mypy")).toBe(true);
  });

  it("lets Claude stop and tells the developer when the stop hook already sent it back", async () => {
    const { dir, write } = repo();
    write("api/app.py", "import os\n");
    const { code, json } = await runHook("claude-stop", dir, stop(dir, true));
    expect(code).toBe(0);
    expect(json?.decision).toBeUndefined();
    expect(json?.systemMessage).toContain("api/app.py");
  });

  it("only format-checks a TypeScript component when just its non-source files changed", async () => {
    const { dir, write } = repo();
    write(".devguard.yaml", `${DECL}  - path: ./web\n    language: typescript\n`);
    write("web/README.md", "# web\n");
    const { code, stdout, calls } = await runHook("claude-stop", dir, stop(dir, false));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(calls.map((c) => [c.tool, ...(c.args ?? [])])).toEqual([["prettier", "--list-different", "README.md"]]);
  });

  it("prints nothing when nothing changed", async () => {
    const { dir } = repo();
    const { code, stdout, calls } = await runHook("claude-stop", dir, stop(dir, false));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
  });

  it("prints nothing when the changed files are clean", async () => {
    const { dir, write } = repo();
    write("api/app.py", "z = 2\n");
    expect((await runHook("claude-stop", dir, stop(dir, false))).stdout).toBe("");
  });
});

describe("devguard hook claude-session-start (SPEC §7.3)", () => {
  it("records claude-last-seen and prints doctor's problems as context", async () => {
    const { dir } = repo();
    const { code, stdout } = await runHook("claude-session-start", dir, {
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".git/devguard/claude-last-seen"))).toBe(true);
    // No git hooks installed: doctor --quiet reports it.
    expect(stdout).toContain("environment/hook-missing");
    expect(stdout).not.toContain("提示 ");
  });
});
