import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { callsDevguard, hookCommandLine, type GitHookName } from "../hooks/file.ts";
import {
  detectFramework,
  frameworkEntry,
  hooksDisabled,
  hooksPathConflict,
  readHooksPath,
  type FrameworkEntry,
  type HookFramework,
} from "../hooks/frameworks.ts";
import { hookFilePath, INSTALLED_HOOKS, installedHook, type InstalledHook } from "../hooks/install.ts";
import type { Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck } from "./types.ts";

const INSTALL = "devguard install";

function problem(rule: string, message: string, fix = INSTALL): Finding {
  return { level: "error", layer: "environment", rule: `environment/${rule}`, message, fix };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * §7.4 steps 1 and 3: `core.hooksPath`, read with the config file that sets it, must not keep the hooks from running:
 * not the null device, no conflict with the framework in use (`hooksPathConflict`), not a missing directory.
 */
async function hooksPathProblem(
  cwd: string,
  framework: HookFramework | undefined,
  exec: Exec,
): Promise<Finding | undefined> {
  const path = await readHooksPath(cwd, exec);
  const conflict = await hooksPathConflict(cwd, framework, exec);
  if (conflict) {
    if (path && hooksDisabled(path)) {
      const unset = `git config --file "${path.origin}" --unset core.hooksPath`;
      return problem("hooks-path-disabled", conflict.message, `${unset}，再執行 ${INSTALL}`);
    }
    return problem("hooks-path-conflict", conflict.message);
  }
  if (!path) return undefined;
  const first = INSTALLED_HOOKS[0];
  if (first && !(await isDirectory(dirname(await hookFilePath(cwd, first, exec))))) {
    return problem(
      "hooks-path-missing",
      `core.hooksPath = ${path.value}（設定於 ${path.origin}）：目錄不存在，git hook 不會執行`,
    );
  }
  return undefined;
}

/** §7.4 step 2 without a hook framework: the hook file exists, has devguard's marker and an intact checksum. */
function hookFileProblem(hook: GitHookName, installed: InstalledHook): Finding | undefined {
  const { path, status, text = "" } = installed;
  switch (status.kind) {
    case "missing":
      return problem("hook-missing", `沒有安裝 git ${hook} hook（${path}）`);
    case "foreign":
      if (callsDevguard(text, hook)) return undefined;
      return problem(
        "hook-foreign",
        `git ${hook} hook（${path}）不是 devguard 產生的，也沒有呼叫 devguard`,
        `在該 hook 中加上：${hookCommandLine(hook)}`,
      );
    case "devguard":
      if (status.intact && status.hook === hook) return undefined;
      return problem("hook-modified", `git ${hook} hook（${path}）被修改過，checksum 不符`);
  }
}

/** §7.4 step 2 with a hook framework: its config calls devguard for the hook. */
function frameworkProblem(hook: GitHookName, entry: FrameworkEntry): Finding | undefined {
  if (entry.present) return undefined;
  return {
    ...problem("framework-entry-missing", `${entry.framework} 的設定中沒有在 ${hook} 呼叫 devguard 的項目`),
    file: entry.file,
  };
}

/** The hook framework's devguard entry for a hook (`frameworkEntry`); undefined when no framework is used. */
export type FrameworkEntryProbe = (cwd: string, hook: GitHookName) => Promise<FrameworkEntry | undefined>;

export interface GitHooksCheckOptions {
  /** Defaults to `frameworkEntry` (src/hooks/frameworks.ts); tests pass a fake. */
  framework?: FrameworkEntryProbe;
}

/** §7.4「已安裝」: core.hooksPath does not silence the hooks, and the hooks devguard installs are in place. */
export function createGitHooksCheck(options: GitHooksCheckOptions = {}): EnvironmentCheck {
  const entryFor = options.framework ?? frameworkEntry;
  return {
    id: "git-hooks",
    async run({ cwd, exec }) {
      const repo = await exec({ file: "git", args: ["rev-parse", "--git-dir"], cwd });
      if (repo.code !== 0) {
        return [problem("not-a-git-repo", `${cwd} 不是 git repo，無法安裝 git hook`, `git init，再執行 ${INSTALL}`)];
      }
      const silenced = await hooksPathProblem(cwd, await detectFramework(cwd), exec);
      if (silenced) return [silenced];
      const findings: Finding[] = [];
      for (const hook of INSTALLED_HOOKS) {
        const entry = await entryFor(cwd, hook);
        const found = entry
          ? frameworkProblem(hook, entry)
          : hookFileProblem(hook, await installedHook(cwd, hook, exec));
        if (found) findings.push(found);
      }
      return findings;
    },
  };
}

export const gitHooksCheck: EnvironmentCheck = createGitHooksCheck();
