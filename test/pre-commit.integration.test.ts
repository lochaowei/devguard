import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { runInstall } from "../src/hooks/install.ts";
import { TODAY } from "./helpers.ts";

/**
 * A real repo with the hook installed; `git commit` runs it through Git for Windows' sh. The hook starts the CLI as
 * `node <this repo>/src/cli.ts` (the exe is not built in tests). The project borrows this repo's node_modules.
 */
const CLI = join(import.meta.dirname, "..", "src", "cli.ts").replace(/\\/g, "/");
let dir = "";

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (name: string, text: string) => {
  writeFileSync(join(dir, name), text);
};

function commit(message: string): { code: number; output: string } {
  const r = spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

const SILENT: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

function install(hookCommand: string) {
  return runInstall({
    cwd: dir,
    today: TODAY,
    io: SILENT,
    hookCommand,
    tools: { run: () => Promise.reject(new Error("no tools")) },
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devguard-hook-"));
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
  const files: Record<string, string> = {
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
    ".gitignore": "node_modules\n",
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
    "eslint.config.js": [
      'import tseslint from "typescript-eslint";',
      'export default tseslint.config(tseslint.configs.recommended, { ignores: ["eslint.config.js"] });',
      "",
    ].join("\n"),
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "include": ["*.ts"] }\n',
    "clean.ts": "export const clean = 1;\n",
  };
  for (const [name, text] of Object.entries(files)) write(name, text);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "setup");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pre-commit hook in a real git commit (SPEC §7.4)", { timeout: 180_000 }, () => {
  it("lets a clean change through; dependency rules do not run when no dependency file is staged", async () => {
    await install(`node "${CLI}"`);
    // The repo has a package.json-less TypeScript component and no lockfile: deps rules would fail if they ran.
    write("clean.ts", "export const clean = 2;\n");
    git("add", "clean.ts");
    const r = commit("clean");
    expect(r.output).not.toContain("deps/");
    expect(r.code).toBe(0);
  });

  it("checks the staged version of a partially staged file, without stashing or restoring anything", async () => {
    await install(`node "${CLI}"`);
    write("clean.ts", "export const clean  =  3;\n");
    git("add", "clean.ts");
    write("clean.ts", "export const clean = 3;\n");
    const r = commit("messy staged");
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("prettier/format");
    expect(r.output).toContain("devguard fix --code clean.ts");
    expect(r.output).toContain("tsc");
    expect(r.output).toContain("工作目錄");
    expect(readFileSync(join(dir, "clean.ts"), "utf8")).toBe("export const clean = 3;\n");
    expect(git("show", ":clean.ts")).toBe("export const clean  =  3;\n");
    git("add", "clean.ts");
    expect(commit("fixed").code).toBe(0);
  });

  it("runs the dependency rules when a dependency file is staged", async () => {
    await install(`node "${CLI}"`);
    write("package.json", '{ "name": "x", "type": "module" }\n');
    git("add", "package.json");
    const r = commit("deps");
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("deps/lockfile-missing");
    git("reset", "-q", "package.json");
  });

  it("blocks the commit with the install command and --no-verify hint when the CLI is missing", async () => {
    await install("devguard-not-installed-here");
    write("clean.ts", "export const clean = 4;\n");
    git("add", "clean.ts");
    const r = commit("no cli");
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("github.com/lochaowei/devguard/releases");
    expect(r.output).toContain("--no-verify");
  });
});
