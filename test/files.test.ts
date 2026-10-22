import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assignFiles, listRepoFiles } from "../src/repo/files.ts";
import type { Exec } from "../src/tools/process.ts";
import { resolveText } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const noGit: Exec = () => Promise.resolve({ code: 128, stdout: "", stderr: "fatal: not a git repository" });

describe("listRepoFiles", () => {
  it("lists tracked and untracked files git does not ignore", async () => {
    const dir = tree({ ".gitignore": "dist/\n", "a.ts": "", "src/b.py": "", "dist/c.js": "" });
    expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    spawnSync("git", ["add", "a.ts"], { cwd: dir });
    expect([...(await listRepoFiles(dir))].sort()).toEqual([".gitignore", "a.ts", "src/b.py"]);
  });

  it("walks the directory when it is not a git repo, skipping dependency folders", async () => {
    const dir = tree({
      "a.ts": "",
      "web/src/b.tsx": "",
      "web/node_modules/x/index.ts": "",
      ".venv/lib/y.py": "",
      ".git/HEAD": "",
    });
    expect([...(await listRepoFiles(dir, noGit))].sort()).toEqual(["a.ts", "web/src/b.tsx"]);
  });

  it("walks the directory when git is not installed", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    expect(await listRepoFiles(tree({ "a.go": "" }), enoent)).toEqual(["a.go"]);
  });

  it("passes other git failures through", async () => {
    const boom: Exec = () => Promise.reject(new Error("boom"));
    await expect(listRepoFiles(tree({}), boom)).rejects.toThrow("boom");
  });
});

describe("assignFiles", () => {
  it("assigns each repo file to its component or inferred language, dropping other files (SPEC §4.1)", () => {
    const { components } = resolveText(
      "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: python}\n  - {path: web/, language: typescript}\n",
    );
    const owned = assignFiles(components, ["app.py", "web/a.ts", "web/tool.py", "svc/main.go", "README.md"]);
    expect(
      owned.map(({ file, owner }) => [file, owner.kind === "component" ? owner.component.name : owner.language]),
    ).toEqual([
      ["app.py", "./ (Python)"],
      ["web/a.ts", "web/ (TypeScript)"],
      ["web/tool.py", "./ (Python)"],
      ["svc/main.go", "go"],
    ]);
  });
});
