import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CheckOptions } from "../check.ts";
import { normalizePath } from "../declaration/path.ts";
import { previewThenApply, type Interaction } from "../fix/interaction.ts";
import { applyPlan, renderPlan, type ChangePlan, type Printed } from "../fix/plan.ts";
import { planConfigFix } from "../fix/run.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { UsageError } from "../report/failure.ts";
import {
  inspectHookFile,
  renderHookFile,
  type GitHookName,
  type HookFileOptions,
  type HookFileStatus,
} from "./file.ts";
import { detectFramework, hooksDisabled, hooksPathConflict, planFrameworkHooks, readHooksPath } from "./frameworks.ts";

/** The hooks `devguard install` writes (SPEC §7.4). */
export const INSTALLED_HOOKS: readonly GitHookName[] = ["pre-commit", "pre-push"];

/** Where git looks for a hook: `core.hooksPath` when set, otherwise `.git/hooks` (also right in a worktree). */
export async function hookFilePath(cwd: string, hook: GitHookName, exec: Exec = nodeExec): Promise<string> {
  const r = await exec({ file: "git", args: ["rev-parse", "--git-path", `hooks/${hook}`], cwd });
  if (r.code !== 0) throw new UsageError(`${cwd} 不是 git repo，無法安裝 git hook`);
  return resolve(cwd, r.stdout.trim());
}

/** A path as shown in the plan: relative to `cwd` when inside it, otherwise absolute; forward slashes. */
function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return normalizePath(rel.startsWith("..") || isAbsolute(rel) ? path : rel);
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface InstalledHook {
  /** Absolute path of the hook file. */
  path: string;
  status: HookFileStatus | { kind: "missing" };
}

/** Whether a hook is installed: missing, someone else's, or devguard's with an intact checksum (for doctor, §7.4). */
export async function installedHook(cwd: string, hook: GitHookName, exec: Exec = nodeExec): Promise<InstalledHook> {
  const path = await hookFilePath(cwd, hook, exec);
  const text = await readOrUndefined(path);
  return { path, status: text === undefined ? { kind: "missing" } : inspectHookFile(text) };
}

/**
 * The hook files to write: a missing or modified devguard hook is (re)generated; a hook devguard did not write is
 * left alone and the line to add is printed instead.
 */
export async function planHooks(
  cwd: string,
  hooks: readonly GitHookName[] = INSTALLED_HOOKS,
  options: HookFileOptions & { exec?: Exec } = {},
): Promise<ChangePlan> {
  const plan: ChangePlan = { writes: [], printed: [] };
  for (const hook of hooks) {
    const path = await hookFilePath(cwd, hook, options.exec);
    const before = (await readOrUndefined(path)) ?? "";
    const after = renderHookFile(hook, options);
    const file = shown(cwd, path);
    if (before !== "" && inspectHookFile(before).kind === "foreign") {
      const line = after.split("\n").find((l) => l.startsWith("command -v")) ?? "";
      plan.printed.push({
        file,
        category: "snippet",
        lines: ["這個 hook 不是 devguard 產生的，不會覆寫；請在其中加上：", line],
      });
    } else if (before !== after) {
      plan.writes.push({ file, category: "generated", before, after, mode: 0o755 });
    }
  }
  return plan;
}

/**
 * What `install` does for the git hooks: inject into the hook framework the repo already uses, or write devguard's own
 * hook files; plus a `core.hooksPath` conflict that would keep them from running (SPEC §7.4).
 */
export async function planInstallHooks(
  cwd: string,
  options: HookFileOptions & { exec?: Exec } = {},
): Promise<ChangePlan> {
  const framework = await detectFramework(cwd);
  const conflict = await hooksPathConflict(cwd, framework, options.exec);
  const printed: Printed[] = conflict ? [{ file: conflict.file, category: "conflict", lines: [conflict.message] }] : [];
  const disabled = hooksDisabled(await readHooksPath(cwd, options.exec));
  if (framework) {
    const plan = await planFrameworkHooks(cwd, framework, INSTALLED_HOOKS, options.command);
    return { writes: plan.writes, printed: [...plan.printed, ...printed] };
  }
  if (disabled) return { writes: [], printed };
  const plan = await planHooks(cwd, INSTALLED_HOOKS, options);
  return { writes: plan.writes, printed: [...plan.printed, ...printed] };
}

export interface InstallOptions extends CheckOptions {
  io: Interaction;
  /** How the hooks start the CLI; defaults to `devguard`. */
  hookCommand?: string;
  exec?: Exec;
}

/**
 * `devguard install` (SPEC §3.2): the tool settings `fix` would generate plus the git hooks, previewed and applied
 * together under the shared interaction rules. Returns the exit code.
 */
export async function runInstall(options: InstallOptions): Promise<0 | 1> {
  const hookOptions = { exec: options.exec, ...(options.hookCommand ? { command: options.hookCommand } : {}) };
  const hooks = await planInstallHooks(options.cwd, hookOptions);
  const config = await planConfigFix(options);
  const plan: ChangePlan = {
    writes: [...config.writes, ...hooks.writes],
    printed: [...config.printed, ...hooks.printed],
  };
  return previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: () => applyPlan(options.cwd, plan),
  });
}
