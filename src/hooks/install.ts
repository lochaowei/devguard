import { isAbsolute, relative } from "node:path";
import { FIX_LAYERS, type CheckOptions } from "../check.ts";
import { CLAUDE_CODE_LAYER_ID, createClaudeCodeLayer } from "../layers/claude-code.ts";
import { normalizePath } from "../declaration/path.ts";
import { previewThenApply, type Interaction } from "../fix/interaction.ts";
import {
  applyPlan,
  hasBlockedWrites,
  renderPlan,
  withoutBlockedWrites,
  type ChangePlan,
  type Printed,
} from "../fix/plan.ts";
import { planConfigFix } from "../fix/run.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { hookCommandLine, inspectHookFile, renderHookFile, type GitHookName, type HookFileOptions } from "./file.ts";
import {
  detectFramework,
  frameworkHooksNotInstalled,
  hooksDisabled,
  hooksPathConflict,
  planFrameworkHooks,
  readHooksPath,
} from "./frameworks.ts";
import { hookFilePath, INSTALLED_HOOKS, installedHook } from "./location.ts";
import { otherTypeCheckers } from "../settings/type-checkers.ts";
import { readIfExists } from "../shared/fs.ts";

/** A path as shown in the plan: relative to `cwd` when inside it, otherwise absolute; forward slashes. */
function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return normalizePath(rel.startsWith("..") || isAbsolute(rel) ? path : rel);
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
    const before = (await readIfExists(path)) ?? "";
    const after = renderHookFile(hook, options);
    const file = shown(cwd, path);
    if (before !== "" && inspectHookFile(before).kind === "foreign") {
      plan.printed.push({
        file,
        category: "snippet",
        lines: ["這個 hook 不是 devguard 產生的，不會覆寫；請在其中加上：", hookCommandLine(hook, options.command)],
      });
    } else if (before !== after) {
      plan.writes.push({ file, category: "generated", before, after, mode: 0o755 });
    }
  }
  return plan;
}

/** The command a devguard hook starts the CLI with, when the file still says so plainly; otherwise the default. */
function hookCommandOf(text: string): string | undefined {
  const program = /command -v (\S+) /.exec(text)?.[1];
  const command = /; exec (.+?) hook git-/.exec(text)?.[1];
  return program && command?.startsWith(program) ? command : undefined;
}

/**
 * What `devguard fix` does for the git hooks (SPEC §9.1): regenerate devguard's own hook files that were modified,
 * keeping the command they start the CLI with. Hooks never installed are `install`'s to add; outside a git repo, or
 * when no hook is devguard's, there is nothing to do.
 */
export async function planFixHooks(cwd: string, exec: Exec = nodeExec): Promise<ChangePlan> {
  const plan: ChangePlan = { writes: [], printed: [] };
  if ((await exec({ file: "git", args: ["rev-parse", "--git-dir"], cwd })).code !== 0) return plan;
  for (const hook of INSTALLED_HOOKS) {
    const installed = await installedHook(cwd, hook, exec);
    if (installed.status.kind !== "devguard" || installed.text === undefined) continue;
    const command = hookCommandOf(installed.text);
    const refreshed = await planHooks(cwd, [hook], { exec, ...(command ? { command } : {}) });
    plan.writes.push(...refreshed.writes);
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
 * together under the shared interaction rules, with a warning for each type checker the project already configures
 * other than the declared one (#68). Returns the exit code.
 */
export async function runInstall(options: InstallOptions): Promise<0 | 1> {
  const hookOptions = { exec: options.exec, ...(options.hookCommand ? { command: options.hookCommand } : {}) };
  const hooks = await planInstallHooks(options.cwd, hookOptions);
  // install creates the Claude Code setup; fix only keeps an existing one current (SPEC §7.3).
  const claude = createClaudeCodeLayer({ create: true, command: options.hookCommand });
  const config = await planConfigFix(
    options,
    FIX_LAYERS.map((l) => (l.id === CLAUDE_CODE_LAYER_ID ? claude : l)),
  );
  const typeCheckers = config.resolution ? await otherTypeCheckers(options.cwd, config.resolution) : [];
  const plan = await withoutBlockedWrites(
    options.cwd,
    { writes: [...config.writes, ...hooks.writes], printed: [...config.printed, ...typeCheckers, ...hooks.printed] },
    options.exec,
  );
  const code = await previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: () => applyPlan(options.cwd, plan),
  });
  // The framework entry does nothing until the framework writes its hooks, which install leaves to the person (#70);
  // the same hooks doctor reports as framework-not-installed.
  const unwritten = await frameworkHooksNotInstalled(options.cwd, options.exec);
  if (unwritten) {
    options.io.write(
      `下一步：執行 ${unwritten.command}，hook 框架才會把 hook 寫進 hooks 目錄（install 不會自動執行）。\n`,
    );
  }
  return hasBlockedWrites(plan) ? 1 : code;
}
