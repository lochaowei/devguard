import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { workingTreeCrlfLayer } from "../src/layers/working-tree-crlf.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runFix } from "../src/fix/run.ts";
import { nodeExec, type Command, type Exec } from "../src/process/exec.ts";
import { exitCodeFor } from "../src/report/render.ts";
import { TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-crlf-"));
  dirs.push(dir);
  return dir;
}

/** A git repo whose files are committed with LF; `crlf` names those then rewritten with CRLF in the working tree. */
function repo(files: Record<string, string>, crlf: readonly string[] = []): string {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "setup");
  for (const name of crlf) writeFileSync(join(dir, name), (files[name] ?? "").replace(/\n/g, "\r\n"));
  return dir;
}

const check = async (dir: string) => (await runCheck({ cwd: dir, today: TODAY }, [workingTreeCrlfLayer])).findings;

describe("check: a CRLF working tree over an LF index (#84)", () => {
  it("reports one repo-wide hint with the file count, examples and how to check out again", async () => {
    const files = { "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n", "d.ts": "d\n" };
    const dir = repo(files, ["a.ts", "b.ts", "c.ts"]);
    const findings = await check(dir);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f).toMatchObject({ level: "hint", layer: "environment", rule: "environment/working-tree-crlf" });
    expect(f?.file).toBeUndefined();
    expect(f?.message).toContain("3 個");
    expect(f?.message).toContain("a.ts");
    expect(f?.message).not.toContain("d.ts");
    expect(f?.message).toContain("pre-commit");
    expect(f?.fix).toContain("git rm --cached -r -q .");
    expect(f?.fix).toContain("git reset --hard");
    expect(f?.fix).toContain("commit");
    expect(exitCodeFor(findings, false)).toBe(0);
  });

  it("reports nothing when every file is LF in the working tree", async () => {
    const dir = repo({ "a.ts": "a\n" });
    expect(await check(dir)).toEqual([]);
  });

  it("reports nothing, and does not fail, outside a git repo", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.ts"), "a\r\n");
    expect(await check(dir)).toEqual([]);
  });

  it("ignores files committed with CRLF (the project's own choice)", async () => {
    const dir = repo({ "a.ts": "a\r\n" });
    expect(await check(dir)).toEqual([]);
  });
});

const DECL = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";

/** Runs `fix --yes` with real git, recording every git command; returns the output and the commands. */
async function fixYes(dir: string): Promise<{ out: string; commands: Command[] }> {
  let out = "";
  const commands: Command[] = [];
  const exec: Exec = (c) => {
    commands.push(c);
    return nodeExec(c);
  };
  const io: Interaction = {
    yes: true,
    interactive: false,
    write: (t) => (out += t),
    confirm: () => Promise.resolve(false),
  };
  expect(await runFix({ cwd: dir, today: TODAY, io, exec })).toBe(0);
  return { out, commands };
}

describe("fix: hint to check out again after adding the eol rule (#84)", () => {
  it("prints the re-checkout commands and the commit-or-stash warning when the working tree has CRLF files", async () => {
    const dir = repo({ ".devguard.yaml": DECL, "app.py": "x = 1\n" }, ["app.py"]);
    const { out, commands } = await fixYes(dir);
    expect(out).toContain("* text=auto eol=lf");
    expect(out).toContain("git rm --cached -r -q .");
    expect(out).toContain("git reset --hard");
    expect(out).toContain("commit 或 stash");
    // fix only reads git: it never checks out, resets or touches the index.
    const subcommands = commands.filter((c) => c.file === "git").map((c) => c.args[0]);
    expect(subcommands.length).toBeGreaterThan(0);
    expect(subcommands.every((s) => s === "rev-parse" || s === "ls-files" || s === "config")).toBe(true);
    expect(readFileSync(join(dir, "app.py"), "utf8")).toBe("x = 1\r\n");
  });

  it("prints no hint when the working tree has no CRLF files", async () => {
    const dir = repo({ ".devguard.yaml": DECL, "app.py": "x = 1\n" });
    const { out } = await fixYes(dir);
    expect(out).toContain("* text=auto eol=lf");
    expect(out).not.toContain("git reset --hard");
  });

  it("keeps a tsconfig.json committed with CRLF in CRLF, so git diff shows only the added settings", async () => {
    const tsconfig = [
      "{",
      '  "compilerOptions": {',
      '    "target": "es2022",',
      '    "module": "nodenext",',
      '    "outDir": "dist",',
      '    "rootDir": "src",',
      '    "declaration": true',
      "  }",
      "}",
      "",
    ].join("\r\n");
    const decl = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n";
    const dir = repo({ ".devguard.yaml": decl, ".gitattributes": "* text=auto eol=lf\n", "tsconfig.json": tsconfig });
    await fixYes(dir);
    const after = readFileSync(join(dir, "tsconfig.json"), "utf8");
    expect(after).not.toBe(tsconfig);
    expect(after.split("\n").length - 1).toBe(after.split("\r\n").length - 1);
    const numstat = execFileSync("git", ["diff", "--numstat", "--", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    const [added, deleted] = numstat.trim().split(/\s+/).map(Number);
    expect(added).toBeGreaterThan(0);
    // Only the line that gains a trailing comma is replaced; the rest of the file is untouched.
    expect(deleted).toBe(1);
  });

  it("prints no hint when .gitattributes already has the rule (nothing written to it)", async () => {
    const files = { ".devguard.yaml": DECL, ".gitattributes": "* text=auto eol=lf\n", "app.py": "x = 1\n" };
    const dir = repo(files, ["app.py"]);
    const { out } = await fixYes(dir);
    expect(out).not.toContain("git reset --hard");
  });
});
