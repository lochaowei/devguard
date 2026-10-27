import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { runInstall } from "../src/hooks/install.ts";
import { isolateGit } from "./git-isolation.ts";
import { TODAY } from "./helpers.ts";

/**
 * #59: a push from a git worktree, whose project tests create a git repo of their own. Git exports GIT_DIR (absolute
 * in a worktree) and friends to the hook; a project tool that inherits them commits into the outer repo.
 *
 * Every repo here, and the remote, is a temporary one this file creates. Should this file itself run under a git
 * hook, the variables would point every git call below at whatever repo ran the hook, so `isolateGit` clears them for
 * this worker first and points HOME and the git config into a temporary directory.
 */
isolateGit();
const base = mkdtempSync(join(tmpdir(), "devguard-worktree-"));

const CLI = join(import.meta.dirname, "..", "src", "cli.ts").replace(/\\/g, "/");
const main = join(base, "main");
const tree = join(base, "tree");

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const SILENT: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

const SUM = "export const sum = (a: number, b: number): number => a + b;\n";

/** A project test that, like any test of a tool working on repos, builds a fixture repo in a temporary directory. */
const REPO_TEST = [
  'import { execFileSync } from "node:child_process";',
  'import { mkdtempSync, writeFileSync } from "node:fs";',
  'import { tmpdir } from "node:os";',
  'import { join } from "node:path";',
  'import { expect, it } from "vitest";',
  'import { sum } from "./sum.ts";',
  'it("builds a fixture repo", () => {',
  '  const d = mkdtempSync(join(tmpdir(), "devguard-fixture-"));',
  '  const g = (...a: string[]) => execFileSync("git", a, { cwd: d });',
  '  writeFileSync(join(d, "app.py"), "print(1)\\n");',
  '  g("init", "-q");',
  '  g("add", ".");',
  '  g("-c", "user.email=f@example.com", "-c", "user.name=f", "commit", "-qm", "fixture");',
  "  expect(sum(1, 2)).toBe(3);",
  "});",
  "",
].join("\n");

beforeAll(async () => {
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  const files: Record<string, string> = {
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
    ".gitignore": "node_modules\n",
    "sum.ts": SUM,
    "repo.test.ts": REPO_TEST,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(main, name), text);
  gitIn(main, "config", "user.email", "t@example.com");
  gitIn(main, "config", "user.name", "t");
  gitIn(main, "config", "core.autocrlf", "false");
  gitIn(main, "remote", "add", "origin", remote);
  gitIn(main, "add", ".");
  gitIn(main, "commit", "-qm", "setup", "--no-verify");
  gitIn(main, "worktree", "add", "-q", "-b", "work", tree);
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(tree, "node_modules"), "junction");
  await runInstall({
    cwd: tree,
    today: TODAY,
    io: SILENT,
    hookCommand: `node "${CLI}"`,
    tools: { run: () => Promise.reject(new Error("no tools")) },
  });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("pre-push hook in a git worktree (SPEC §7.4, #59)", { timeout: 180_000 }, () => {
  it("runs project tests that create a git repo without touching the outer repo", () => {
    const state = () => ({
      head: gitIn(tree, "rev-parse", "HEAD"),
      log: gitIn(tree, "log", "--format=%H %an %s", "--all"),
      status: gitIn(tree, "status", "--porcelain", "--untracked-files=all"),
    });
    const before = state();
    const env = { ...process.env, DEVGUARD_PRE_PUSH: "full" };
    const r = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: tree, encoding: "utf8", env });
    expect(state()).toEqual(before);
    expect(`${r.stdout}${r.stderr}`).toBe("");
    expect(r.status).toBe(0);
  });
});
