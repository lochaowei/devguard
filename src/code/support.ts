import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, sep } from "node:path";
import { normalizePath } from "../declaration/path.ts";
import type { Finding, Level } from "../report/finding.ts";
import { failureCause } from "../tools/failure-cause.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../tools/runner.ts";
import type { CodeCheckContext, CodeTarget } from "./types.ts";

/** Helpers shared by the per-language code checkers. */

/**
 * A path printed by a tool (absolute, or relative to the target directory) as a repo-relative path. Some tools
 * (ESLint) print real paths, so an absolute path outside `cwd` is retried against `cwd` with symlinks resolved: on
 * macOS the temp directory `/var/…` is really `/private/var/…`.
 */
export function toRepoPath(cwd: string, dir: string, path: string): string {
  if (!isAbsolute(path)) return normalizePath(posix.normalize(dir + normalizePath(path)));
  const rel = relative(cwd, path);
  if (!outside(rel)) return normalizePath(rel);
  const real = relative(realCwd(cwd), path);
  return normalizePath(outside(real) ? rel : real);
}

const outside = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

const realCwds = new Map<string, string>();

function realCwd(cwd: string): string {
  let real = realCwds.get(cwd);
  if (real === undefined) {
    try {
      real = realpathSync(cwd);
    } catch {
      real = cwd;
    }
    realCwds.set(cwd, real);
  }
  return real;
}

/**
 * The file arguments for each run: "." for the whole directory, otherwise the files split into groups
 * short enough for cmd.exe (8191 characters per command line, SPEC §3.2).
 */
export function fileBatches(files: readonly string[] | undefined, maxChars = 4000): string[][] {
  if (files === undefined) return [["."]];
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const file of files) {
    if (current.length > 0 && length + file.length + 1 > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Runs a tool once per file batch and collects the results. */
export async function runBatched(
  tools: ToolRunner,
  request: Omit<ToolRequest, "args">,
  args: readonly string[],
  files: readonly string[] | undefined,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const batch of fileBatches(files)) results.push(await tools.run({ ...request, args: [...args, ...batch] }));
  return results;
}

export interface StagedSplit {
  /** Files (relative to the target directory) whose staged version differs from the file on disk, with that version. */
  staged: { file: string; text: string }[];
  /** The other files, checked on disk; undefined means the whole directory, [] means none. */
  onDisk: readonly string[] | undefined;
}

/**
 * Splits the target's files into those checked through stdin and those checked on disk. Only a file whose staged
 * version differs from the working tree (partially staged, or deleted after staging) needs stdin, which costs one tool
 * run per file. A staged version identical to the file on disk is checked there, so all such files share one run
 * (#205): the tool reads the same text either way.
 */
export async function splitStaged(target: CodeTarget, ctx: CodeCheckContext): Promise<StagedSplit> {
  if (ctx.staged === undefined || target.files === undefined) return { staged: [], onDisk: target.files };
  const versions = await stagedVersions(target, ctx);
  const differs = await Promise.all(
    versions.map(async ({ file, text }) => text !== (await ctx.readText(target.dir + file))),
  );
  const staged = versions.filter((_, i) => differs[i] === true);
  const viaStdin = new Set(staged.map((s) => s.file));
  return { staged, onDisk: target.files.filter((file) => !viaStdin.has(file)) };
}

/** The target's files whose staged version is known, with that version, whatever the working tree holds. */
export async function stagedVersions(target: CodeTarget, ctx: CodeCheckContext): Promise<StagedSplit["staged"]> {
  const { staged: read } = ctx;
  if (read === undefined || target.files === undefined) return [];
  const versions: StagedSplit["staged"] = [];
  // One at a time: a read may start a git process.
  for (const file of target.files) {
    const text = await read(target.dir + file);
    if (text !== undefined) versions.push({ file, text });
  }
  return versions;
}

/** 1-based number of the first line where `actual` and `expected` differ (1 when they are equal). */
export function firstDifferentLine(actual: string, expected: string): number {
  const a = actual.split("\n");
  const b = expected.split("\n");
  const i = a.findIndex((line, n) => line !== b[n]);
  return i === -1 ? Math.min(a.length, b.length) : i + 1;
}

export interface CodeFindingInput {
  level?: Level;
  rule: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Defaults to `devguard fix --code <file>` when there is a file. */
  fix?: string;
  /** Whether `devguard fix --code` resolves it. Defaults to true exactly when the default `fix` applies. */
  fixable?: boolean;
}

/** A finding in the code layer, attributed to the target's component. */
export function codeFinding(target: CodeTarget, input: CodeFindingInput): Finding {
  const { level = "error", rule, message, file, line, column } = input;
  const fix = input.fix ?? (file === undefined ? undefined : `devguard fix --code ${file}`);
  const fixable = input.fixable ?? (input.fix === undefined && file !== undefined);
  const optional = { component: target.component, file, line, column, fix };
  const present = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) as Partial<Finding>;
  return { level, layer: "code", rule, message, ...present, fixable };
}

/** The tool ran but did not produce a usable result (crash, bad configuration). */
export function toolFailed(target: CodeTarget, tool: string, result: ToolResult): Finding {
  const output = failureCause(tool, result, "first").join("\n");
  return codeFinding(target, {
    rule: "code/tool-failed",
    message: `${tool} 執行失敗（exit ${String(result.code)}）${output === "" ? "" : `：${output}`}`,
    fix: `在 ${target.dir === "" ? "repo 根目錄" : target.dir} 直接執行 ${tool} 查看完整訊息`,
  });
}
