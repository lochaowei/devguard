import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planHooks } from "../src/hooks/install.ts";
import { afterShebang, HUSKY_V4_HOOK } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A repo whose pre-commit hook is husky v4's, with the line `install` prints put where it says; `husky.sh` exits 0 as
 * husky's does when the project has no husky config. `command` stands in for the CLI: a shell command with a fixed
 * exit status, so this checks the line's shell behaviour, not devguard's checks.
 */
async function commitThroughForeignHook(command: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "devguard-foreign-hook-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  const hook = join(dir, ".git/hooks/pre-commit");
  writeFileSync(hook, HUSKY_V4_HOOK);
  const { printed } = await planHooks(dir, ["pre-commit"], { command });
  writeFileSync(hook, afterShebang(HUSKY_V4_HOOK, printed[0]?.lines[1] ?? ""));
  writeFileSync(join(dir, ".git/hooks/husky.sh"), "exit 0\n");
  chmodSync(hook, 0o755);
  return spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: dir }).status ?? 1;
}

describe("the line install prints for a foreign hook, in a real git commit (#126)", () => {
  it("fails the commit when devguard fails, though the rest of the hook would exit 0", async () => {
    expect(await commitThroughForeignHook('sh -c "exit 3"')).not.toBe(0);
  });

  it("lets the commit through when devguard passes", async () => {
    expect(await commitThroughForeignHook("true")).toBe(0);
  });
});
