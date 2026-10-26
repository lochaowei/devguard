import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Resolution, ResolvedComponent } from "../declaration/resolve.ts";
import type { Layout, Repair } from "../fix/repair.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { parseJsonc } from "../settings/config-files.ts";
import { EXTENSION_LANGUAGE, type ItemDef, type Standard } from "../standard/types.ts";
import { readIfExists } from "../shared/fs.ts";
import { isRecord } from "../shared/guards.ts";
import { workspaceLayout } from "../vscode/workspace.ts";

/** The Claude Code files `devguard install` generates and commits (SPEC §7.3). */
export const CLAUDE_SETTINGS = ".claude/settings.json";
export const CLAUDE_RULES_DIR = ".claude/rules";
export const DOCTOR_SKILL = ".claude/skills/standards-doctor/SKILL.md";

/** The Claude Code hooks: event, `devguard hook` subcommand, matcher, and whether a hook failure blocks. */
interface ClaudeHook {
  event: "SessionStart" | "PostToolUse" | "Stop";
  hook: string;
  matcher?: string;
  /** `onFailure` has no effect on Stop (Claude Code docs), so Stop does not set it. */
  blockOnFailure: boolean;
}

export const CLAUDE_HOOKS: readonly ClaudeHook[] = [
  { event: "SessionStart", hook: "claude-session-start", blockOnFailure: true },
  { event: "PostToolUse", hook: "claude-post-edit", matcher: "Edit|Write", blockOnFailure: true },
  { event: "Stop", hook: "claude-stop", blockOnFailure: false },
];

/** How the hooks start the CLI: exec form needs one executable and its arguments (no shell). */
function launcher(command = "devguard"): { command: string; args: string[] } {
  const [file = "devguard", ...args] = command.trim().split(/\s+/);
  return { command: file, args };
}

/** One hook's matcher group in `.claude/settings.json`: exec form, run at the project root. */
export function hookGroup(hook: ClaudeHook, command?: string): Record<string, unknown> {
  const exe = launcher(command);
  const handler = {
    type: "command",
    command: exe.command,
    args: [...exe.args, "hook", hook.hook, "--cwd", "${CLAUDE_PROJECT_DIR}"],
    ...(hook.blockOnFailure ? { onFailure: "block" } : {}),
  };
  return { ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [handler] };
}

/** A matcher group devguard wrote: one of its handlers runs `devguard hook claude-*`. */
function isDevguardGroup(group: unknown): boolean {
  const hooks = isRecord(group) ? group.hooks : undefined;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => {
      const args = isRecord(h) ? h.args : undefined;
      if (!Array.isArray(args)) return false;
      const at = args.indexOf("hook");
      return at >= 0 && typeof args[at + 1] === "string" && String(args[at + 1]).startsWith("claude-");
    })
  );
}

/**
 * The managed keys of `.claude/settings.json`: each event's devguard group replaces the previous one in place (or is
 * appended); other hooks the project set stay untouched. `layout` is the project's Prettier width, as for `.vscode/`.
 */
export function settingsRepairs(text: string | undefined, command?: string, layout: Layout = {}): Repair[] {
  const parsed = text === undefined ? {} : parseJsonc(text);
  const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : {};
  return CLAUDE_HOOKS.flatMap((hook): Repair[] => {
    const current: unknown[] = Array.isArray(hooks[hook.event]) ? (hooks[hook.event] as unknown[]) : [];
    const wanted = hookGroup(hook, command);
    const at = current.findIndex(isDevguardGroup);
    const others = current.filter((g) => !isDevguardGroup(g));
    const after = at < 0 ? [...others, wanted] : [...others.slice(0, at), wanted, ...others.slice(at)];
    if (JSON.stringify(after) === JSON.stringify(current)) return [];
    return [{ op: "set", file: CLAUDE_SETTINGS, path: ["hooks", hook.event], value: after, layout }];
  });
}

/** `.claude/rules/standards-<元件>.md`: the directory (root = `root`) and language. */
export function rulesFile(component: Pick<ResolvedComponent, "dir" | "language">): string {
  const dir = component.dir.replace(/\/$/, "").replace(/[^A-Za-z0-9_.-]+/g, "-") || "root";
  return `${CLAUDE_RULES_DIR}/standards-${dir}-${component.language}.md`;
}

/** The `paths` globs of a component's rules: its directory and its language's extensions. */
export function rulesPaths(component: Pick<ResolvedComponent, "dir" | "language">): string[] {
  const exts = Object.entries(EXTENSION_LANGUAGE)
    .filter(([, language]) => language === component.language)
    .map(([ext]) => ext.slice(1));
  const pattern = exts.length === 1 ? (exts[0] ?? "") : `{${exts.join(",")}}`;
  return [`${component.dir}**/*.${pattern}`];
}

const show = (value: unknown): string => {
  if (Array.isArray(value)) return value.length === 0 ? "（無）" : value.map((v) => show(v)).join("、");
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
};

/** Rules files stay under this many lines (SPEC §7.3). */
export const RULES_MAX_LINES = 200;

/** A component's standard, condensed for Claude: the items in force, then the deviations and their reasons. */
export function rulesText(component: ResolvedComponent, standard: Standard): string {
  const defs: Readonly<Record<string, ItemDef>> = standard.languages[component.language];
  const items = Object.entries(component.effective).filter(([key]) => defs[key] !== undefined);
  const deviations = items.filter(([, item]) => item.accepted === true);
  const lines = [
    "---",
    "paths:",
    ...rulesPaths(component).map((p) => `  - "${p}"`),
    "---",
    `# ${component.name} 的標準（${standard.id}）`,
    "",
    "修改這個元件的檔案時遵守以下標準。完成修改後執行 `devguard check` 確認；" +
      "格式與可自動修正的 lint 用 `devguard fix --code <檔案>` 修正。",
    "",
    "## 標準項目",
    "",
    ...items.map(([key, item]) => `- ${defs[key]?.label ?? key}（${key}）：${show(item.value)}`),
    "",
    "## 目前的偏離",
    "",
    ...(deviations.length === 0
      ? ["（無）"]
      : deviations.map(
          ([key, item]) =>
            `- ${defs[key]?.label ?? key}：${show(item.value)}｜理由：${item.reason ?? ""}｜到期：${item.until ?? "未設"}`,
        )),
  ];
  const kept = lines.slice(0, RULES_MAX_LINES - 2);
  if (kept.length < lines.length) kept.push("…（其餘項目見 .devguard.yaml 與 devguard check）");
  return `${kept.join("\n")}\n`;
}

/** `/standards-doctor`: only the developer can call it; the CLI may run under Bash or PowerShell (SPEC §7.3). */
export const DOCTOR_SKILL_TEXT = `---
name: standards-doctor
description: 執行 devguard doctor，說明專案標準的檢查結果，經開發者同意後修正
disable-model-invocation: true
allowed-tools: Bash(devguard *), PowerShell(devguard *)
---
# 標準診斷

以下是 \`devguard doctor --format claude\` 的結果：

!\`devguard doctor --format claude --exit-zero\`

請依照結果向開發者說明每一項問題與修正方式。

- 設定類的問題：詢問開發者是否同意，同意後才執行 \`devguard fix --yes\`。
- 程式碼的格式與 lint：同意後執行 \`devguard fix --code <檔案> --yes\`。
- 其餘問題依每一項附的修正方式處理。
- 若上方沒有出現檢查結果（例如組織關閉了 skill 中的指令執行），請直接執行 \`devguard doctor --format claude\`。
`;

/** Everything the Claude Code setup should contain, as repairs `fix` / `install` apply by file category. */
export async function claudeRepairs(cwd: string, resolution: Resolution, command?: string): Promise<Repair[]> {
  const standard = resolution.standard;
  if (!standard) return [];
  const text = await readIfExists(join(cwd, CLAUDE_SETTINGS));
  const settings = settingsRepairs(text, command, workspaceLayout(resolution));
  const rules = resolution.components.map((c): Repair => ({
    op: "generate",
    file: rulesFile(c),
    content: rulesText(c, standard),
  }));
  return [...settings, ...rules, { op: "generate", file: DOCTOR_SKILL, content: DOCTOR_SKILL_TEXT }];
}

/** The project has devguard's Claude Code setup: its hooks in `.claude/settings.json`, or its rules or skill. */
export async function hasClaudeSetup(cwd: string): Promise<boolean> {
  const settings = parseJsonc((await readIfExists(join(cwd, CLAUDE_SETTINGS))) ?? "");
  const hooks = isRecord(settings) && isRecord(settings.hooks) ? Object.values(settings.hooks) : [];
  if (hooks.some((groups) => Array.isArray(groups) && groups.some(isDevguardGroup))) return true;
  if ((await readIfExists(join(cwd, DOCTOR_SKILL))) !== undefined) return true;
  try {
    return (await readdir(join(cwd, CLAUDE_RULES_DIR))).some((f) => /^standards-.*\.md$/.test(f));
  } catch {
    return false;
  }
}

/** Where SessionStart records that Claude Code ran devguard's hooks here (SPEC §7.3), inside the git directory. */
export const LAST_SEEN = "devguard/claude-last-seen";
/** Where versions before the rename to devguard wrote it; still read so an existing record keeps counting. */
export const LEGACY_LAST_SEEN = "standards-guard/claude-last-seen";

/** The absolute path of `claude-last-seen` (or of `name` in the git directory), or undefined outside a git repo. */
export async function lastSeenPath(cwd: string, exec: Exec = nodeExec, name = LAST_SEEN): Promise<string | undefined> {
  const r = await exec({ file: "git", args: ["rev-parse", "--git-path", name], cwd });
  return r.code === 0 ? resolve(cwd, r.stdout.trim()) : undefined;
}
