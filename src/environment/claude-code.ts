import { stat } from "node:fs/promises";
import { hasClaudeSetup, lastSeenPath, LEGACY_LAST_SEEN } from "../claude/setup.ts";
import type { Exec, ExecResult } from "../process/exec.ts";
import type { Finding, Level } from "../report/finding.ts";
import { compareVersion } from "../standard/registry.ts";
import { parseVersion } from "../versions/range.ts";
import type { EnvironmentCheck, EnvironmentContext } from "./types.ts";

const MIN_VERSION = "claude.minVersion";

function finding(level: Level, rule: string, message: string, fix: string): Finding {
  return { level, layer: "environment", rule: `environment/${rule}`, message, fix };
}

/** `claude --version`; npm installs a `claude.cmd` shim on Windows, run through cmd.exe. Undefined when not found. */
async function claudeVersion(cwd: string, exec: Exec): Promise<string | undefined> {
  const names = process.platform === "win32" ? ["claude", "claude.cmd"] : ["claude"];
  for (const file of names) {
    let r: ExecResult;
    try {
      r = await exec({ file, args: ["--version"], cwd });
    } catch {
      continue;
    }
    if (r.code === 0) return r.stdout.trim();
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code on this machine, for a project with devguard's Claude Code setup (SPEC §7.3): the version reaches
 * `claude.minVersion` (`onFailure` needs it), and SessionStart has recorded `claude-last-seen` at least once.
 */
export const claudeCodeCheck: EnvironmentCheck = {
  id: "claude-code",
  async run(ctx) {
    if (!(await hasClaudeSetup(ctx.cwd))) return [];
    return [...(await versionProblem(ctx)), ...(await neverRan(ctx))];
  },
};

/** `claude.minVersion` as the declaration resolved it, else the standard's default. */
function minVersion(resolution: EnvironmentContext["resolution"]): number[] | undefined {
  const wanted = resolution?.global[MIN_VERSION]?.value ?? resolution?.standard?.global[MIN_VERSION]?.value;
  return typeof wanted === "string" ? parseVersion(wanted) : undefined;
}

/** The installed Claude Code reaches `claude.minVersion`; a missing `claude` command is only a hint. */
async function versionProblem({ cwd, exec, resolution }: EnvironmentContext): Promise<Finding[]> {
  const output = await claudeVersion(cwd, exec);
  if (output === undefined) {
    return [finding("hint", "claude-missing", "找不到 claude 指令，無法確認 Claude Code 的版本", "安裝 Claude Code")];
  }
  const have = parseVersion(output);
  const need = minVersion(resolution);
  if (!have || !need || compareVersion(have, need) >= 0) return [];
  const message = `Claude Code ${have.join(".")} 低於 ${MIN_VERSION} ${need.join(".")}（hook 的 onFailure 需要此版本）`;
  return [finding("error", "claude-version", message, "claude update")];
}

/** SessionStart has written `claude-last-seen` at least once (SPEC §7.3). */
async function neverRan({ cwd, exec }: EnvironmentContext): Promise<Finding[]> {
  const seen = await lastSeenPath(cwd, exec);
  if (!seen || (await exists(seen))) return [];
  const legacy = await lastSeenPath(cwd, exec, LEGACY_LAST_SEEN);
  if (legacy && (await exists(legacy))) return [];
  return [
    finding(
      "hint",
      "claude-never-ran",
      "Claude Code 的 hook 可能從未執行過，或尚未信任此資料夾",
      "在此資料夾啟動 Claude Code 並接受信任資料夾的詢問",
    ),
  ];
}
