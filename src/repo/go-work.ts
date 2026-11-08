import { posix } from "node:path";

const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1").replace(/^`(.*)`$/, "$1");

/** The paths a go.work file's `use` directives list, as written: the one-line form and `use ( ... )` blocks. */
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
 * The module directories a go.work file in `workDir` (normalized, "" for the repo root) uses, as normalized
 * repo-relative directories ("" for the root, else ending in "/"). Paths outside the repo are left out.
 */
export function goWorkModules(text: string, workDir: string): Set<string> {
  const dirs = new Set<string>();
  for (const path of usePaths(text)) {
    const joined = posix.join(workDir || ".", path.replace(/\\/g, "/"));
    if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) continue;
    dirs.add(joined === "." ? "" : joined.replace(/\/?$/, "/"));
  }
  return dirs;
}
