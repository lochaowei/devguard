import { resolve } from "node:path";
import { nodeExec, type Exec } from "../process/exec.ts";
import { UsageError } from "../report/failure.ts";
import { readIfExists } from "../shared/fs.ts";
import { inspectHookFile, type GitHookName, type HookFileStatus } from "./file.ts";

/** The hooks `devguard install` writes (SPEC §7.4). */
export const INSTALLED_HOOKS: readonly GitHookName[] = ["pre-commit", "pre-push"];

/** Where git looks for a hook: `core.hooksPath` when set, otherwise `.git/hooks` (also right in a worktree). */
export async function hookFilePath(cwd: string, hook: GitHookName, exec: Exec = nodeExec): Promise<string> {
  const r = await exec({ file: "git", args: ["rev-parse", "--git-path", `hooks/${hook}`], cwd });
  if (r.code !== 0) throw new UsageError(`${cwd} 不是 git repo，無法安裝 git hook`);
  return resolve(cwd, r.stdout.trim());
}

export interface InstalledHook {
  /** Absolute path of the hook file. */
  path: string;
  status: HookFileStatus | { kind: "missing" };
  /** The file's content, when it exists. */
  text?: string;
}

/** Whether a hook is installed: missing, someone else's, or devguard's with an intact checksum (for doctor, §7.4). */
export async function installedHook(cwd: string, hook: GitHookName, exec: Exec = nodeExec): Promise<InstalledHook> {
  const path = await hookFilePath(cwd, hook, exec);
  const text = await readIfExists(path);
  return text === undefined ? { path, status: { kind: "missing" } } : { path, status: inspectHookFile(text), text };
}
