import { globSource } from "../shared/glob.ts";
import { normalizePath } from "./path.ts";

/**
 * An `ignore:` entry (SPEC §4) as a test on repo-relative, forward-slash paths. A plain path matches that file or
 * everything under that directory; a glob (`*`, `?`, `**`) matches a path, or every file under a directory it
 * matches.
 */
function matcher(pattern: string): (path: string) => boolean {
  const p = normalizePath(pattern).replace(/\/+$/, "");
  if (!/[*?]/.test(p)) return (path) => path === p || path.startsWith(p + "/");
  const re = new RegExp(`^${globSource(p)}(?:/.*)?$`);
  return (path) => re.test(path);
}

/**
 * Whether the `ignore:` entry excludes every file under `dir` (normalized, "" for the repo root): it names the
 * directory or one above it, or ends in `/**` or `/*` after such a directory.
 */
export function coversDirectory(pattern: string, dir: string): boolean {
  const whole = normalizePath(pattern)
    .replace(/\/+$/, "")
    .replace(/\/\*\*?$/, "");
  return matcher(whole)(dir.replace(/\/$/, ""));
}

/** The files not excluded by the declaration's `ignore:` entries. */
export function withoutIgnored(patterns: readonly string[], files: readonly string[]): readonly string[] {
  if (patterns.length === 0) return files;
  const matchers = patterns.map(matcher);
  return files.filter((file) => {
    const path = normalizePath(file);
    return !matchers.some((m) => m(path));
  });
}
