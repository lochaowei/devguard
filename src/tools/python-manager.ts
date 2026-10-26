import { upwards } from "../repo/paths.ts";

/** The package manager a Python component uses (SPEC §6.1 `deps.manager`). */
export type PythonManager = "uv" | "poetry";

/** The Python lockfiles that decide the manager, repo-relative and nearest first: `<dir>uv.lock`, `<dir>poetry.lock`, … */
export function pythonLockfiles(dir: string): string[] {
  return upwards(dir).flatMap((d) => [`${d}uv.lock`, `${d}poetry.lock`]);
}

/**
 * Poetry when the nearest Python lockfile is `poetry.lock`; uv otherwise. Running tools, the mirror check and
 * `standard upgrade` all decide this way. `exists` takes a repo-relative path.
 */
export function pythonManager(dir: string, exists: (file: string) => boolean): PythonManager {
  const nearest = pythonLockfiles(dir).find(exists);
  return nearest?.endsWith("poetry.lock") ? "poetry" : "uv";
}

/** `pythonManager` through an async reader of repo-relative files (undefined when a file does not exist). */
export async function readPythonManager(
  dir: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<PythonManager> {
  const present = new Set<string>();
  for (const file of pythonLockfiles(dir)) if ((await read(file)) !== undefined) present.add(file);
  return pythonManager(dir, (file) => present.has(file));
}
