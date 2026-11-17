import { upwards } from "../repo/paths.ts";
import { isRecord } from "../shared/guards.ts";
import type { ReadRepoFile } from "./pinned.ts";

/** A package found installed in a `node_modules` directory. */
export interface InstalledPackage {
  /** Repo-relative path of the `package.json` the version came from. */
  file: string;
  version: string;
}

/**
 * The version of `name` actually installed for the TypeScript component in `dir`: the `version` of the nearest
 * `node_modules/<name>/package.json` from `dir` upwards, as Node resolves it (#212). Undefined when it is not installed.
 */
export function installedNpmPackage(dir: string, name: string, read: ReadRepoFile): InstalledPackage | undefined {
  for (const base of upwards(dir)) {
    const file = `${base}node_modules/${name}/package.json`;
    const text = read(file);
    if (text === undefined) continue;
    try {
      const doc: unknown = JSON.parse(text);
      if (isRecord(doc) && typeof doc.version === "string") return { file, version: doc.version };
    } catch {
      // An unreadable package.json is the same as one that does not say its version.
    }
  }
  return undefined;
}
