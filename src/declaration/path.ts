/** Normalizes a component or file path to forward slashes with no leading "./"; "" is the repo root. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "." || s === "/") return "";
  return s.replace(/^\/+/, "");
}

/** Component paths are directories: normalized and ending in "/" (except the root, ""). */
export function normalizeDir(p: string): string {
  const s = normalizePath(p);
  return s === "" || s.endsWith("/") ? s : s + "/";
}

export function displayDir(dir: string): string {
  return dir === "" ? "./" : dir;
}
