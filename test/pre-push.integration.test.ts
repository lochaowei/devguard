import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { runInstall } from "../src/hooks/install.ts";
import { TODAY } from "./helpers.ts";

/**
 * A real repo with the hooks installed, pushing to a local bare repo; `git push` runs the pre-push hook through Git
 * for Windows' sh, which starts the CLI as `node <this repo>/src/cli.ts`, which runs the real Vitest with coverage.
 * The project borrows this repo's node_modules.
 */
const CLI = join(import.meta.dirname, "..", "src", "cli.ts").replace(/\\/g, "/");
let dir = "";
let remote = "";

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (name: string, text: string) => {
  writeFileSync(join(dir, name), text);
};
const commit = (message: string) => git("commit", "-qam", message, "--no-verify");

function push(): { code: number; output: string } {
  const r = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

const SILENT: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

const SUM = "export const sum = (a: number, b: number): number => a + b;\n";
const SUM_TEST = [
  'import { expect, it } from "vitest";',
  'import { sum } from "./sum.ts";',
  'it("adds", () => expect(sum(1, 2)).toBe(3));',
  "",
].join("\n");

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "devguard-push-"));
  dir = join(base, "work");
  remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", dir]);
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
  const files: Record<string, string> = {
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
    ".gitignore": "node_modules\n",
    "sum.ts": SUM,
    "sum.test.ts": SUM_TEST,
  };
  for (const [name, text] of Object.entries(files)) write(name, text);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("remote", "add", "origin", remote);
  git("add", ".");
  commit("setup");
  await runInstall({
    cwd: dir,
    today: TODAY,
    io: SILENT,
    hookCommand: `node "${CLI}"`,
    tools: { run: () => Promise.reject(new Error("no tools")) },
  });
});

afterAll(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("pre-push hook in a real git push (SPEC §7.1, §7.4)", { timeout: 180_000 }, () => {
  it("lets the push through without any output when the tests pass and coverage is met", () => {
    const r = push();
    expect(r.output).toBe("");
    expect(r.code).toBe(0);
  });

  it("blocks the push when a test fails", () => {
    write("sum.test.ts", SUM_TEST.replace("toBe(3)", "toBe(4)"));
    commit("broken test");
    const r = push();
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("test/failed");
    expect(r.output).toContain("adds");
    write("sum.test.ts", SUM_TEST);
    commit("fixed test");
  });

  it("blocks the push when coverage is below the standard", () => {
    const untested = Array.from({ length: 20 }, (_, i) => `export const f${String(i)} = (): number => ${String(i)};`);
    write("sum.ts", [SUM, ...untested, ""].join("\n"));
    commit("untested code");
    const r = push();
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("coverage/");
  });
});
