import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { callsDevguard, hookCallLine, type GitHookName } from "../hooks/file.ts";
import { hookFilePath, INSTALLED_HOOKS, installedHook, type InstalledHook } from "../hooks/install.ts";
import type { Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck } from "./types.ts";

const INSTALL = "devguard install";

function problem(rule: string, message: string, fix = INSTALL): Finding {
  return { level: "error", layer: "environment", rule: `environment/${rule}`, message, fix };
}

/** `core.hooksPath` and where it is set (SPEC §7.4 step 1). */
export interface HooksPathSetting {
  value: string;
  /** git's config scope: local, global, system, worktree or command. */
  scope: string;
  /** The config file (or other origin) that sets it, as git prints it, e.g. `file:.git/config`. */
  origin: string;
}

/** Reads `core.hooksPath` with its scope and origin; undefined when it is not set. */
export async function readHooksPath(cwd: string, exec: Exec): Promise<HooksPathSetting | undefined> {
  const r = await exec({
    file: "git",
    args: ["config", "--show-scope", "--show-origin", "--get", "core.hooksPath"],
    cwd,
  });
  if (r.code !== 0) return undefined;
  const [scope = "", origin = "", ...value] = r.stdout.replace(/\r?\n$/, "").split("\t");
  return { scope, origin, value: value.join("\t") };
}

const where = (s: HooksPathSetting): string => `${s.scope} ${s.origin.replace(/^file:/, "")}`;

/** How to remove the setting from where it is set. */
function unsetCommand(s: HooksPathSetting): string {
  return ["local", "global", "system", "worktree"].includes(s.scope)
    ? `git config --${s.scope} --unset core.hooksPath`
    : `移除 core.hooksPath 設定（${where(s)}）`;
}

const DISCARDS = new Set(["/dev/null", "nul"]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** §7.4 step 3: core.hooksPath pointing at /dev/null or a directory that does not exist silences every hook. */
async function hooksPathProblem(cwd: string, exec: Exec): Promise<Finding | undefined> {
  const setting = await readHooksPath(cwd, exec);
  if (!setting) return undefined;
  const shown = `core.hooksPath = ${setting.value}（設定於 ${where(setting)}）`;
  if (DISCARDS.has(setting.value.trim().toLowerCase())) {
    return problem(
      "hooks-path-disabled",
      `${shown}：git hook 全部不會執行`,
      `${unsetCommand(setting)}，再執行 ${INSTALL}`,
    );
  }
  const first = INSTALLED_HOOKS[0];
  if (first && !(await isDirectory(dirname(await hookFilePath(cwd, first, exec))))) {
    return problem("hooks-path-missing", `${shown}：目錄不存在，git hook 不會執行`);
  }
  return undefined;
}

/** What is wrong with one installed hook file, if anything (§7.4 step 2, without a hook framework). */
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
        `在該 hook 中加上：${hookCallLine(hook)}`,
      );
    case "devguard":
      if (status.intact && status.hook === hook) return undefined;
      return problem("hook-modified", `git ${hook} hook（${path}）被修改過，checksum 不符`);
  }
}

/** An existing hook framework (pre-commit, husky, lefthook) the project uses, as far as doctor needs to know. */
export interface HookFrameworkUse {
  name: string;
  /** Repo-relative config file where the devguard entry belongs, e.g. `.pre-commit-config.yaml`. */
  file: string;
  /** The hooks whose devguard entry is missing from the framework's config. */
  missing: readonly GitHookName[];
}

/** Which hook framework the project uses, if any, and whether its config calls devguard for `hooks`. */
export type HookFrameworkProbe = (cwd: string, hooks: readonly GitHookName[]) => Promise<HookFrameworkUse | undefined>;

/**
 * Until the hook-framework ticket (#20) supplies the real probe, no framework is detected and the hook files are
 * checked. #20 passes its probe as the default `framework` below.
 */
export const noHookFramework: HookFrameworkProbe = () => Promise.resolve(undefined);

export interface GitHooksCheckOptions {
  framework?: HookFrameworkProbe;
}

/** §7.4「已安裝」: core.hooksPath does not silence the hooks, and the hooks devguard installs are in place. */
export function createGitHooksCheck(options: GitHooksCheckOptions = {}): EnvironmentCheck {
  const framework = options.framework ?? noHookFramework;
  return {
    id: "git-hooks",
    async run({ cwd, exec }) {
      const repo = await exec({ file: "git", args: ["rev-parse", "--git-dir"], cwd });
      if (repo.code !== 0) {
        return [problem("not-a-git-repo", `${cwd} 不是 git repo，無法安裝 git hook`, `git init，再執行 ${INSTALL}`)];
      }
      const silenced = await hooksPathProblem(cwd, exec);
      if (silenced) return [silenced];
      const used = await framework(cwd, INSTALLED_HOOKS);
      if (used) {
        return used.missing.map((hook) => ({
          ...problem("framework-entry-missing", `${used.name} 的設定中沒有在 ${hook} 呼叫 devguard 的項目`),
          file: used.file,
        }));
      }
      const findings: Finding[] = [];
      for (const hook of INSTALLED_HOOKS) {
        const found = hookFileProblem(hook, await installedHook(cwd, hook, exec));
        if (found) findings.push(found);
      }
      return findings;
    },
  };
}

export const gitHooksCheck: EnvironmentCheck = createGitHooksCheck();
