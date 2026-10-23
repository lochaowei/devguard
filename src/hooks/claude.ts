import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runCheck } from "../check.ts";
import { CODE_CATEGORIES, type CodeCategory } from "../code/types.ts";
import { lastSeenPath } from "../claude/setup.ts";
import { normalizePath } from "../declaration/path.ts";
import { runDoctor } from "../doctor.ts";
import { checkTargets, codeCheckContext, codeTargets } from "../layers/code.ts";
import { declarationLayer } from "../layers/declaration.ts";
import type { CheckLayer } from "../layers/types.ts";
import { nodeExec } from "../process/exec.ts";
import { claudeFeedback } from "../report/claude.ts";
import type { Finding } from "../report/finding.ts";
import { exitCodeFor, problemsOnly } from "../report/render.ts";
import { isRecord } from "../settings/config-files.ts";
import type { HookContext } from "./pre-commit.ts";

/** The hook's JSON input from stdin (Claude Code passes it to every command hook). */
async function hookInput(ctx: HookContext): Promise<Record<string, unknown>> {
  const text = ctx.stdin ? await ctx.stdin() : "";
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

function print(ctx: HookContext, text: string): void {
  (ctx.stdout ?? ctx.write)(text);
}

/** The code checks of the given categories (SPEC §7.1), through the same CodeCheckers as `check`. */
function codeChecks(categories: readonly CodeCategory[]): CheckLayer {
  return {
    id: "code",
    async run(ctx) {
      const targets = (await codeTargets(ctx)).map((t) => ({
        ...t,
        target: { ...t.target, categories: new Set(categories) },
      }));
      return { findings: await checkTargets(targets, codeCheckContext(ctx)) };
    },
  };
}

/** Code findings for these repo-relative files. Problems with the declaration itself are left to doctor. */
async function checkFiles(
  ctx: HookContext,
  files: readonly string[],
  categories: readonly CodeCategory[],
): Promise<Finding[]> {
  if (files.length === 0) return [];
  const scope = { files, full: false };
  const result = await runCheck({ ...ctx, scope, listFiles: () => Promise.resolve([...files]) }, [
    declarationLayer,
    codeChecks(categories),
  ]);
  return result.findings.filter((f) => f.layer === "code");
}

/** A path from the hook input as a repo-relative path, or undefined when it lies outside the project. */
function inProject(cwd: string, path: string): string | undefined {
  const rel = relative(cwd, resolve(cwd, path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return normalizePath(rel);
}

const block = (findings: readonly Finding[]) => JSON.stringify({ decision: "block", reason: claudeFeedback(findings) });

/**
 * `devguard hook claude-post-edit` (PostToolUse, matcher `Edit|Write`): lint and format check of the edited file only.
 * Problems go back to Claude as `decision: "block"` with exit 0 (SPEC §7.3).
 */
export async function runClaudePostEdit(ctx: HookContext): Promise<number> {
  const input = await hookInput(ctx);
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const path = typeof toolInput.file_path === "string" ? inProject(ctx.cwd, toolInput.file_path) : undefined;
  if (path === undefined) return 0;
  const findings = await checkFiles(ctx, [path], ["lint", "format"]);
  if (exitCodeFor(findings, false) !== 0) print(ctx, `${block(findings)}\n`);
  return 0;
}

/** The files changed in the working tree since the last commit, new ones included, deleted ones left out. */
async function changedFiles(ctx: HookContext): Promise<string[]> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
  const r = await (ctx.exec ?? nodeExec)({ file: "git", args, cwd: ctx.cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr.trim()}`);
  return r.stdout
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3))
    .filter((p) => existsSync(join(ctx.cwd, p)));
}

/**
 * `devguard hook claude-stop` (Stop): lint, format and type checks of every file changed this turn, found with git
 * (so edits made through Bash count too). When Claude is already continuing because of this hook and the checks
 * still fail, Claude is let go and the developer is told instead, so it cannot loop (SPEC §7.3).
 */
export async function runClaudeStop(ctx: HookContext): Promise<number> {
  const input = await hookInput(ctx);
  const findings = await checkFiles(ctx, await changedFiles(ctx), CODE_CATEGORIES);
  if (exitCodeFor(findings, false) === 0) return 0;
  if (input.stop_hook_active === true) {
    const message = `devguard：Claude 修正後仍有問題，已讓它結束這一輪，請自行處理。\n${claudeFeedback(findings)}`;
    print(ctx, `${JSON.stringify({ systemMessage: message })}\n`);
  } else {
    print(ctx, `${block(findings)}\n`);
  }
  return 0;
}

/**
 * `devguard hook claude-session-start` (SessionStart): records `claude-last-seen`, then runs `doctor --quiet`; its
 * problems go to stdout, which Claude Code adds to the session's context (SPEC §7.3).
 */
export async function runClaudeSessionStart(ctx: HookContext): Promise<number> {
  await hookInput(ctx);
  const exec = ctx.exec ?? nodeExec;
  const seen = await lastSeenPath(ctx.cwd, exec);
  if (seen) {
    await mkdir(dirname(seen), { recursive: true });
    await writeFile(seen, `${new Date().toISOString()}\n`);
  }
  const result = problemsOnly(await runDoctor({ ...ctx, exec }));
  if (result.findings.length > 0) print(ctx, `${claudeFeedback(result.findings)}\n`);
  return 0;
}
