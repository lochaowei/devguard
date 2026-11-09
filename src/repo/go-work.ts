import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readIfExists } from "../shared/fs.ts";
import { upwards } from "./paths.ts";

const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1").replace(/^`(.*)`$/, "$1");

/**
 * The paths a go.work file's `use` directives list, as written. go.work has had the same directive syntax since Go
 * 1.18 (golang.org/x/mod/modfile, checked through Go 1.26): `go work init ./a` writes the one-line `use ./a`,
 * `go work use` rewrites it as a `use (` block with one path per line; paths may be quoted with `"` or backquotes,
 * and `//` starts a comment. Other directives (`go`, `toolchain`, `godebug`, `replace`) are skipped.
 */
function usePaths(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else if (line) out.push(unquote(line));
      continue;
    }
    const use = /^use(?=[\s(])\s*(.*)$/.exec(line)?.[1];
    if (use === undefined) continue;
    if (!use.startsWith("(")) {
      if (use) out.push(unquote(use));
      continue;
    }
    const inner = use.slice(1).trim();
    inBlock = !inner.endsWith(")");
    const single = inner.replace(/\)$/, "").trim();
    if (single) out.push(unquote(single));
  }
  return out;
}

/**
 * The module directories a go.work file in the absolute directory `workDir` uses, relative to the absolute
 * `repoRoot` and normalized ("" for the root, else ending in "/"). Paths outside the repo are left out.
 */
export function goWorkModules(text: string, workDir: string, repoRoot: string): Set<string> {
  const dirs = new Set<string>();
  for (const path of usePaths(text)) {
    const rel = relative(repoRoot, resolve(workDir, path.replace(/\\/g, "/"))).replace(/\\/g, "/");
    if (rel === ".." || rel.startsWith("../") || /^(?:[A-Za-z]:)?\//.test(rel)) continue;
    dirs.add(rel === "" ? "" : `${rel}/`);
  }
  return dirs;
}

/**
 * For each module directory (normalized, repo-relative) that a go.work applies to, the module directories that
 * go.work uses. Like `go`, the nearest go.work at or above the module counts, whether or not git tracks it and even
 * above the repo root. Modules with no go.work above them are left out.
 */
export async function goWorkspaces(
  repoRoot: string,
  moduleDirs: readonly string[],
): Promise<Map<string, ReadonlySet<string>>> {
  const root = resolve(repoRoot);
  const cache = new Map<string, Promise<ReadonlySet<string> | undefined>>();
  const read = (dir: string) => {
    const found =
      cache.get(dir) ??
      readIfExists(join(dir, "go.work")).then((t) => (t === undefined ? undefined : goWorkModules(t, dir, root)));
    cache.set(dir, found);
    return found;
  };
  const above: string[] = [];
  for (let d = root; d !== dirname(d);) {
    d = dirname(d);
    above.push(d);
  }
  const out = new Map<string, ReadonlySet<string>>();
  for (const dir of moduleDirs) {
    const candidates = [...upwards(dir).map((d) => join(root, d)), ...above];
    const work = candidates.find((d) => existsSync(join(d, "go.work")));
    const used = work === undefined ? undefined : await read(work);
    if (used) out.set(dir, used);
  }
  return out;
}

/**
 * For each module directory (normalized, repo-relative) that the nearest go.work inside the repo uses, that
 * go.work's directory, normalized like the module directories. Modules no go.work in the repo uses are left out.
 */
export async function goWorkDirs(repoRoot: string, moduleDirs: readonly string[]): Promise<Map<string, string>> {
  const root = resolve(repoRoot);
  const out = new Map<string, string>();
  for (const dir of moduleDirs) {
    const workDir = upwards(dir).find((d) => existsSync(join(root, d, "go.work")));
    if (workDir === undefined) continue;
    const text = await readIfExists(join(root, workDir, "go.work"));
    if (text !== undefined && goWorkModules(text, join(root, workDir), root).has(dir)) out.set(dir, workDir);
  }
  return out;
}
