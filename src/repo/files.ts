import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { findOwner, type FileOwner } from "../declaration/lookup.ts";
import { normalizePath } from "../declaration/path.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { nodeExec, type Exec } from "../tools/process.ts";

/** Directories never walked when the repo is not under git: VCS data and installed dependencies. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "vendor", "target", "build", "dist"]);

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => normalizePath(relative(root, `${e.parentPath}/${e.name}`)))
    .filter((p) => !p.split("/").some((part) => SKIPPED_DIRS.has(part)))
    .sort();
}

/**
 * Repo-relative, forward-slash paths of the repo's files: what git tracks plus untracked files it does not ignore.
 * Outside a git repo (or without git), walks the directory instead.
 */
export async function listRepoFiles(cwd: string, exec: Exec = nodeExec): Promise<string[]> {
  try {
    const r = await exec({ file: "git", args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd });
    if (r.code === 0) return [...new Set(r.stdout.split("\0").filter((p) => p !== ""))];
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== "ENOENT") throw e;
  }
  return walk(cwd);
}

export interface OwnedFile {
  file: string;
  owner: Exclude<FileOwner, { kind: "out-of-scope" }>;
}

/** Which component (or inferred default standard) governs each file; files outside the four languages are dropped (SPEC §4.1). */
export function assignFiles(components: readonly ResolvedComponent[], files: readonly string[]): OwnedFile[] {
  return files.flatMap((file) => {
    const owner = findOwner(components, file);
    return owner.kind === "out-of-scope" ? [] : [{ file, owner }];
  });
}
