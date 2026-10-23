import { runCheck, type CheckOptions } from "../check.ts";
import { CODE_CHECKERS } from "../code/registry.ts";
import { CODE_CATEGORIES } from "../code/types.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { isDependencyFile } from "../deps/manifests.ts";
import { codeLayer } from "../layers/code.ts";
import { declarationLayer } from "../layers/declaration.ts";
import { depsLayer } from "../layers/deps.ts";
import type { CheckLayer } from "../layers/types.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import { exitCodeFor, renderText } from "../report/render.ts";
import { assignFiles } from "../repo/files.ts";

export interface HookContext extends Omit<CheckOptions, "scope" | "listFiles" | "stagedText"> {
  /** Runs git; defaults to the real one. */
  exec?: Exec;
  /** Where the hook's report goes (git shows the hook's output to the person committing). */
  write: (text: string) => void;
  /** The hook's input on stdin (Claude Code hooks get a JSON object); absent when the caller passes none. */
  stdin?: () => Promise<string>;
  /** Where structured output goes (Claude Code reads the hook's stdout); defaults to `write`. */
  stdout?: (text: string) => void;
}

interface StagedEntry {
  status: string;
  path: string;
}

async function git(ctx: HookContext, args: string[]): Promise<string> {
  const r = await (ctx.exec ?? nodeExec)({ file: "git", args, cwd: ctx.cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr.trim()}`);
  return r.stdout;
}

const nulList = (out: string) => out.split("\0").filter((p) => p !== "");

/** `git diff --cached --name-status -z`: status and path of each staged change (renames as delete + add). */
async function stagedEntries(ctx: HookContext): Promise<StagedEntry[]> {
  const parts = nulList(await git(ctx, ["diff", "--cached", "--name-status", "-z", "--no-renames"]));
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });
  return entries;
}

const effectiveValues = (c: ResolvedComponent) =>
  Object.fromEntries(Object.entries(c.effective).map(([k, item]) => [k, item.value]));

/** The tools that will check the working tree rather than the staged version of these files, by language. */
function workingTreeTools(components: readonly ResolvedComponent[], files: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const { owner } of assignFiles(components, files)) {
    const component = owner.kind === "component" ? owner.component : undefined;
    const language = owner.kind === "component" ? owner.component.language : owner.language;
    const target = {
      dir: component?.dir ?? "",
      language,
      effective: component ? effectiveValues(component) : {},
      categories: new Set(CODE_CATEGORIES),
    };
    for (const tool of CODE_CHECKERS[language]?.workingTreeTools(target) ?? []) tools.add(tool);
  }
  return [...tools];
}

function fixLine(findings: readonly Finding[]): string {
  const files = [...new Set(findings.flatMap((f) => (f.layer === "code" && f.file !== undefined ? [f.file] : [])))];
  return files.length === 0 ? "" : `修正程式碼：devguard fix --code ${files.join(" ")}\n`;
}

/**
 * `devguard hook git-pre-commit` (SPEC §7.4, §7.1): lint and format the staged files, type-check their components,
 * and run the dependency rules only when a dependency file is staged. Formatters and single-file linters read the
 * staged version (`git show :<path>`) through stdin; nothing is stashed or restored. Only checks, never fixes; on
 * failure prints the `devguard fix --code` command. Returns the exit code (non-zero blocks the commit).
 */
export async function runPreCommit(ctx: HookContext): Promise<number> {
  const entries = await stagedEntries(ctx);
  if (entries.length === 0) return 0;
  const files = entries.filter((e) => e.status !== "D").map((e) => e.path);
  const staged = new Set(files);
  const layers: CheckLayer[] = [declarationLayer];
  if (entries.some((e) => isDependencyFile(e.path))) layers.push(depsLayer);
  layers.push(codeLayer);
  const result = await runCheck(
    {
      ...ctx,
      scope: { files, full: false },
      listFiles: () => Promise.resolve(files),
      stagedText: async (path) => (staged.has(path) ? git(ctx, ["show", `:${path}`]) : undefined),
    },
    layers,
  );
  const unstaged = new Set(nulList(await git(ctx, ["diff", "--name-only", "-z"])));
  const partial = files.filter((f) => unstaged.has(f));
  const tools = workingTreeTools(result.resolution?.components ?? [], partial);
  if (tools.length > 0) {
    ctx.write(
      `注意：${partial.join("、")} 有未 staged 的修改。lint 與格式檢查用的是 staged 版本，` +
        `但 ${tools.join("、")} 沒有 stdin 模式，檢查的是工作目錄版本。\n`,
    );
  }
  const code = exitCodeFor(result.findings, false);
  if (result.findings.length > 0) ctx.write(renderText(result));
  if (code !== 0) ctx.write(fixLine(result.findings));
  return code;
}
