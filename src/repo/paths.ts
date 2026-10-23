/**
 * A normalized repo directory ("" for the root, otherwise ending in "/") and every directory above it, nearest
 * first, ending with "" (the repo root). For files that tools look up upwards: lockfiles of a workspace, the build
 * wrapper of a multi-module build, lombok.config.
 */
export function upwards(dir: string): string[] {
  const out = [dir];
  let d = dir;
  while (d !== "") {
    d = d.slice(0, d.slice(0, -1).lastIndexOf("/") + 1);
    out.push(d);
  }
  return out;
}
