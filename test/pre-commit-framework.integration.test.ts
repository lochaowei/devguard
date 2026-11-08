import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInstall } from "../src/hooks/install.ts";
import { TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

/** The real pre-commit framework; skipped where it is not installed (CI has none). */
const hasPreCommit = spawnSync("pre-commit", ["--version"]).status === 0;

/** The hooks start the CLI as `node <this repo>/src/cli.ts` (the exe is not built in tests). */
const CLI = join(import.meta.dirname, "..", "src", "cli.ts").replace(/\\/g, "/");

/** A project hook without `stages` that always fails: `git rev-parse` of a ref that does not exist. */
const PROJECT_CONFIG = `repos:
  - repo: local
    hooks:
      - id: always-fails
        name: always-fails
        entry: git rev-parse --verify --quiet refs/heads/no-such-branch
        language: unsupported
        pass_filenames: false
        always_run: true
`;

let base = "";
let dir = "";

function run(file: string, args: string[]): { code: number; output: string } {
  const r = spawnSync(file, args, { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasPreCommit)(
  "pre-commit framework with both hook types installed (#95)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      base = mkdtempSync(join(tmpdir(), "devguard-pre-commit-framework-"));
      dir = join(base, "project");
      const remote = join(base, "remote.git");
      mkdirSync(dir);
      // pre-commit's own cache stays in the temp directory too.
      process.env.PRE_COMMIT_HOME = join(base, "pre-commit-home");
      writeFileSync(join(dir, ".devguard.yaml"), "standard: team@1.0.0\ncomponents: []\n");
      writeFileSync(join(dir, ".pre-commit-config.yaml"), PROJECT_CONFIG);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      const io = { yes: true, interactive: false, write: () => undefined, confirm: () => Promise.resolve(false) };
      await runInstall({ cwd: dir, today: TODAY, io, hookCommand: `node ${CLI}` });
      // The next step install prints.
      execFileSync("pre-commit", ["install", "--hook-type", "pre-commit", "--hook-type", "pre-push"], { cwd: dir });
      git("add", ".");
    });

    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    it("still runs the project's hook without `stages` on git commit", () => {
      const r = run("git", ["commit", "-q", "-m", "blocked"]);
      expect(r.output).toMatch(/always-fails\.+Failed/);
      expect(r.code).not.toBe(0);
    });

    it("does not run it on git push, which devguard's own pre-push lets through", () => {
      run("git", ["commit", "-q", "--no-verify", "-m", "setup"]);
      const r = run("git", ["push", "-q", "origin", "HEAD:refs/heads/main"]);
      expect(r.output).not.toContain("always-fails");
      expect(r.output).toMatch(/devguard\.+Passed/);
      expect(r.code).toBe(0);
    });
  },
);
