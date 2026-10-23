import { isAbsolute, posix, relative } from "node:path";
import { normalizePath } from "../declaration/path.ts";
import type { Finding, Level } from "../report/finding.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../tools/runner.ts";
import type { CodeTarget } from "./types.ts";

/** Helpers shared by the per-language code checkers. */

/** A path printed by a tool (absolute, or relative to the target directory) as a repo-relative path. */
export function toRepoPath(cwd: string, dir: string, path: string): string {
  if (isAbsolute(path)) return normalizePath(relative(cwd, path));
  return normalizePath(posix.normalize(dir + normalizePath(path)));
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

export interface CodeFindingInput {
  level?: Level;
  rule: string;
  message: string;
  file?: string;
  line?: number;
  /** Defaults to `devguard fix --code <file>` when there is a file. */
  fix?: string;
}

/** A finding in the code layer, attributed to the target's component. */
export function codeFinding(target: CodeTarget, input: CodeFindingInput): Finding {
  const { level = "error", rule, message, file, line } = input;
  const fix = input.fix ?? (file === undefined ? undefined : `devguard fix --code ${file}`);
  return {
    level,
    layer: "code",
    rule,
    message,
    ...(target.component === undefined ? {} : { component: target.component }),
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    ...(fix === undefined ? {} : { fix }),
  };
}

/** The tool ran but did not produce a usable result (crash, bad configuration). */
export function toolFailed(target: CodeTarget, tool: string, result: ToolResult): Finding {
  const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(0, 5).join("\n");
  return codeFinding(target, {
    rule: "code/tool-failed",
    message: `${tool} 執行失敗（exit ${String(result.code)}）${output === "" ? "" : `：${output}`}`,
    fix: `在 ${target.dir === "" ? "repo 根目錄" : target.dir} 直接執行 ${tool} 查看完整訊息`,
  });
}
