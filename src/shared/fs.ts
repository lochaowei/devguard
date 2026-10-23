import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const missing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** A text file's content, or undefined when it does not exist; any other error is thrown. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}

/** `readIfExists`, synchronously (for readers that pin tool versions). */
export function readIfExistsSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}

/** A reader of repo-relative paths under `cwd`. */
export const repoReader =
  (cwd: string) =>
  (repoPath: string): Promise<string | undefined> =>
    readIfExists(join(cwd, repoPath));

/** `repoReader`, synchronously. */
export const repoReaderSync =
  (cwd: string) =>
  (repoPath: string): string | undefined =>
    readIfExistsSync(join(cwd, repoPath));

/** Whether `path` is an existing directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether something exists at `path`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The error a process start or file read gives for a missing program or file. */
export const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
