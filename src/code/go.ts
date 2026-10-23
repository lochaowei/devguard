import { posix } from "node:path";
import type { Finding } from "../report/finding.ts";
import { goEnv } from "../tools/go-env.ts";
import type { ToolResult } from "../tools/runner.ts";
import { codeFinding, firstDifferentLine, runBatched, splitStaged, toolFailed, toRepoPath } from "./support.ts";
import type { CodeCategory, CodeChecker, CodeCheckContext, CodeTarget } from "./types.ts";

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  Pos: { Filename: string; Line?: number; Column?: number };
  /** golangci-lint v2: the fixes `run --fix` can apply. */
  SuggestedFixes?: unknown[] | null;
  /** golangci-lint v1: the replacement `run --fix` applies. */
  Replacement?: unknown;
}

function parseIssues(stdout: string): GolangciIssue[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as { Issues?: unknown };
    return Array.isArray(parsed.Issues) ? (parsed.Issues as GolangciIssue[]) : undefined;
  } catch {
    return undefined;
  }
}

/** golangci-lint v2 reports its formatters' problems as issues too, under the formatter's name. */
const FORMATTERS = new Set(["gofumpt", "goimports", "gofmt", "gci", "golines", "swaggo"]);

const isFormatRule = (rule: string) => FORMATTERS.has(rule.replace(/^golangci-lint\//, ""));

function categoryOf(linter: string): CodeCategory {
  if (FORMATTERS.has(linter)) return "format";
  return linter === "typecheck" ? "typecheck" : "lint";
}

/** The manual fix for an issue `golangci-lint run --fix` cannot resolve; undefined when it can. */
function manualFix(issue: GolangciIssue): string | undefined {
  if (FORMATTERS.has(issue.FromLinter)) return undefined;
  if ((issue.SuggestedFixes?.length ?? 0) > 0 || (issue.Replacement ?? null) !== null) return undefined;
  return issue.FromLinter === "typecheck" ? "手動修正型別錯誤" : "依 golangci-lint 訊息手動修改";
}

function issueFindings(target: CodeTarget, ctx: CodeCheckContext, result: ToolResult): Finding[] {
  const issues = result.code <= 1 ? parseIssues(result.stdout) : undefined;
  if (!issues) return [toolFailed(target, "golangci-lint", result)];
  const wanted = issues.filter((i) => target.categories.has(categoryOf(i.FromLinter)));
  return wanted.map((i) =>
    codeFinding(target, {
      level: i.Severity === "warning" || i.Severity === "info" ? "hint" : "error",
      rule: `golangci-lint/${i.FromLinter}`,
      message: i.Text,
      file: toRepoPath(ctx.cwd, target.dir, i.Pos.Filename),
      line: i.Pos.Line,
      column: i.Pos.Column,
      fix: manualFix(i),
    }),
  );
}

/** GOTOOLCHAIN=local plus the standard's Go mirrors, for every golangci-lint run (SPEC §3.2, §10.2). */
function mirrorEnv(target: CodeTarget): Record<string, string> {
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return goEnv({ proxy: text(target.effective["mirrors.go"]), sumdb: text(target.effective["mirrors.gosumdb"]) });
}

/**
 * golangci-lint loads whole packages, so a file list becomes the list of package directories ("." or "./pkg");
 * undefined means the whole component ("./...").
 */
function packageDirs(files: readonly string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined;
  const dirs = files.filter((f) => f.endsWith(".go")).map((f) => posix.dirname(f));
  return [...new Set(dirs)].map((d) => (d === "." ? "." : `./${d}`));
}

/**
 * The staged version through `golangci-lint fmt --stdin`, which applies the configured formatters (gofumpt,
 * goimports) and prints the result; any difference is a format finding (SPEC §7.4).
 */
async function formatStaged(target: CodeTarget, ctx: CodeCheckContext, file: string, text: string): Promise<Finding[]> {
  const request = { language: "go", tool: "golangci-lint", dir: target.dir, env: mirrorEnv(target) } as const;
  const result = await ctx.tools.run({ ...request, args: ["fmt", "--stdin"], stdin: text });
  if (result.code !== 0) return [toolFailed(target, "golangci-lint fmt", result)];
  if (result.stdout === text) return [];
  const at = { file: toRepoPath(ctx.cwd, target.dir, file), line: firstDifferentLine(text, result.stdout) };
  return [codeFinding(target, { rule: "golangci-lint/fmt", message: "格式不符合 gofumpt / goimports", ...at })];
}

/**
 * golangci-lint v2 (linters and formatters such as gofumpt / goimports) from PATH
 * (SPEC §5.2, §6.2). One run covers lint, format and type errors; issues are sorted into categories afterwards.
 * Staged files (pre-commit) get their format checked through stdin instead.
 */
export const goChecker: CodeChecker = {
  language: "go",
  // golangci-lint `run` loads whole packages from disk; only `fmt` reads stdin.
  workingTreeTools: () => ["golangci-lint"],
  async check(target, ctx) {
    const packages = packageDirs(target.files);
    if (packages?.length === 0) return [];
    const request = { language: "go", tool: "golangci-lint", dir: target.dir, env: mirrorEnv(target) } as const;
    const args = ["run", "--output.json.path=stdout", "--show-stats=false", "--path-mode=abs"];
    const results = await runBatched(ctx.tools, request, args, packages ?? ["./..."]);
    const findings = results.flatMap((r) => issueFindings(target, ctx, r));
    if (target.files === undefined) return findings;
    const staged = target.categories.has("format")
      ? (await splitStaged(target, ctx)).staged.filter((s) => s.file.endsWith(".go"))
      : [];
    const stagedPaths = new Set(staged.map((s) => toRepoPath(ctx.cwd, target.dir, s.file)));
    // Other files of the same packages are not what was asked for; a staged file's format is judged from stdin.
    const asked = new Set(target.files.map((f) => toRepoPath(ctx.cwd, target.dir, f)));
    const kept = findings.filter(
      (f) => f.file === undefined || (asked.has(f.file) && !(stagedPaths.has(f.file) && isFormatRule(f.rule))),
    );
    for (const { file, text } of staged) kept.push(...(await formatStaged(target, ctx, file, text)));
    return kept;
  },
  /** `run --fix` applies the linters' suggested fixes and the configured formatters (gofumpt, goimports...). */
  fixSteps(target) {
    const packages = packageDirs(target.files);
    if (packages?.length === 0) return Promise.resolve([]);
    const args = ["run", "--fix", "--show-stats=false"];
    return Promise.resolve([
      { tool: "golangci-lint", args, files: packages ?? ["./..."], env: mirrorEnv(target), okUpTo: 1 },
    ]);
  },
};
