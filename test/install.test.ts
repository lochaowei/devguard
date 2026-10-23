import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { inspectHookFile } from "../src/hooks/file.ts";
import { runInstall } from "../src/hooks/install.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}, git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-install-"));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function io(yes = true): Interaction & { out: string } {
  const result = {
    out: "",
    yes,
    interactive: false,
    write: (text: string) => {
      result.out += text;
    },
    confirm: () => Promise.resolve(false),
  };
  return result;
}

const DECL = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

describe("devguard install (SPEC §3.2, §7.4)", () => {
  it("installs .git/hooks/pre-commit with the CLI marker and checksum", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    const out = io();
    expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
    const hook = read(dir, ".git/hooks/pre-commit");
    expect(inspectHookFile(hook)).toEqual({ kind: "devguard", hook: "pre-commit", intact: true });
    expect(hook).toContain("exec devguard hook git-pre-commit");
    expect(out.out).toContain(".git/hooks/pre-commit：新增");
  });

  it("generates the tool settings the standard asks for in the same run", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(read(dir, "pyproject.toml")).toContain("[tool.ruff]");
  });

  it("writes into core.hooksPath when it is set", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(inspectHookFile(read(dir, ".githooks/pre-commit")).kind).toBe("devguard");
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("uses the given hook command", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io(), hookCommand: "node cli.ts" });
    expect(read(dir, ".git/hooks/pre-commit")).toContain("exec node cli.ts hook git-pre-commit");
  });

  it("regenerates a modified devguard hook and leaves an intact one alone", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const path = join(dir, ".git/hooks/pre-commit");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("exec devguard", "exec true || devguard"));
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(readFileSync(path, "utf8")).toBe(original);
    const again = io();
    expect(await runInstall({ cwd: dir, today: TODAY, io: again })).toBe(0);
    expect(again.out).not.toContain("pre-commit");
  });

  it("also installs .git/hooks/pre-push with the CLI marker and checksum", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    const hook = read(dir, ".git/hooks/pre-push");
    expect(inspectHookFile(hook)).toEqual({ kind: "devguard", hook: "pre-push", intact: true });
    expect(hook).toContain("exec devguard hook git-pre-push");
    expect(out.out).toContain(".git/hooks/pre-push：新增");
  });

  it("does not overwrite a hook devguard did not write, and prints the line to add", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".git/hooks/pre-commit": "#!/bin/sh\nnpx lint-staged\n" });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    expect(read(dir, ".git/hooks/pre-commit")).toBe("#!/bin/sh\nnpx lint-staged\n");
    expect(out.out).toContain("不是 devguard 產生的");
    expect(out.out).toContain("devguard hook git-pre-commit");
  });

  it("only previews without --yes in a non-interactive run", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    expect(await runInstall({ cwd: dir, today: TODAY, io: io(false) })).toBe(1);
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("refuses outside a git repository", async () => {
    const dir = repo({ ".devguard.yaml": DECL }, false);
    await expect(runInstall({ cwd: dir, today: TODAY, io: io() })).rejects.toThrow("git repo");
  });
});
