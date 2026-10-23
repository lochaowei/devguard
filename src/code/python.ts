import type { Finding } from "../report/finding.ts";
import type { ToolResult } from "../tools/runner.ts";
import { codeFinding, runBatched, toolFailed, toRepoPath } from "./support.ts";
import type { CodeChecker, CodeCheckContext, CodeTarget } from "./types.ts";

interface RuffDiagnostic {
  code: string | null;
  message: string;
  filename: string;
  location?: { row: number };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ruffFindings(target: CodeTarget, ctx: CodeCheckContext, result: ToolResult): Finding[] {
  const diagnostics = result.code <= 1 ? parseJson(result.stdout) : undefined;
  if (!Array.isArray(diagnostics)) return [toolFailed(target, "ruff", result)];
  return (diagnostics as RuffDiagnostic[]).map((d) =>
    codeFinding(target, {
      rule: `ruff/${d.code ?? "syntax-error"}`,
      message: d.message,
      file: toRepoPath(ctx.cwd, target.dir, d.filename),
      line: d.location?.row,
    }),
  );
}

/** `--force-exclude` keeps Ruff's configured excludes in force for explicitly passed files. */
async function lint(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const request = { language: "python", tool: "ruff", dir: target.dir } as const;
  const args = ["check", "--output-format", "json", "--no-fix", "--force-exclude"];
  const results = await runBatched(ctx.tools, request, args, target.files);
  return results.flatMap((r) => ruffFindings(target, ctx, r));
}

const HUNK_HEADER = /^@@ -(\d+)/;

/** The first changed line of each file in a unified diff, keyed by the path in its `---` header. */
function firstChangedLines(diff: string): Map<string, number> {
  const lines = new Map<string, number>();
  let file: string | undefined;
  let line = 0;
  for (const text of diff.split(/\r?\n/)) {
    if (text.startsWith("--- ")) {
      file = text.slice(4).trim();
      continue;
    }
    if (file === undefined || text.startsWith("+++ ") || lines.has(file)) continue;
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith(" ")) line += 1;
    else if (text.startsWith("-") || text.startsWith("+")) lines.set(file, line);
  }
  return lines;
}

/** `ruff format --diff` checks without writing; the diff locates the first line each file would change. */
async function format(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const request = { language: "python", tool: "ruff", dir: target.dir } as const;
  const results = await runBatched(ctx.tools, request, ["format", "--diff", "--force-exclude"], target.files);
  return results.flatMap((result) => {
    if (result.code > 1) return [toolFailed(target, "ruff format", result)];
    return [...firstChangedLines(result.stdout)].map(([file, line]) =>
      codeFinding(target, {
        rule: "ruff/format",
        message: "格式不符合 Ruff format",
        file: toRepoPath(ctx.cwd, target.dir, file),
        line,
      }),
    );
  });
}

const TYPE_FIX = "手動修正型別錯誤";

/** `src/a.py:3: error: message  [code]`; also `file: error: message` for errors without a line (bad config). */
const MYPY_ERROR = /^(.+?):(?:(\d+):(?:\d+:)?)? error: (.*?)(?: {2}\[([\w-]+)\])?$/;

function mypyFinding(target: CodeTarget, ctx: CodeCheckContext, text: string): Finding | undefined {
  const m = MYPY_ERROR.exec(text);
  if (!m) return undefined;
  const [, file = "", line, message = "", code] = m;
  return codeFinding(target, {
    rule: `mypy/${code ?? "error"}`,
    message,
    file: toRepoPath(ctx.cwd, target.dir, file),
    line: line === undefined ? undefined : Number(line),
    fix: TYPE_FIX,
  });
}

/** mypy checks the whole component ("."), honouring its configured excludes (SPEC §7.1). */
async function mypy(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const args = ["--no-pretty", "--no-error-summary", "--show-error-codes", "--no-color-output", "."];
  const result = await ctx.tools.run({ language: "python", tool: "mypy", dir: target.dir, args });
  if (result.code === 0) return [];
  const findings = result.stdout.split(/\r?\n/).flatMap((text) => mypyFinding(target, ctx, text) ?? []);
  return findings.length > 0 ? findings : [toolFailed(target, "mypy", result)];
}

interface PyrightDiagnostic {
  file?: string;
  severity: "error" | "warning" | "information";
  message: string;
  rule?: string;
  range?: { start: { line: number } };
}

/** pyright with no file arguments checks the project its configuration describes. */
async function pyright(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const request = { language: "python", tool: "pyright", dir: target.dir, args: ["--outputjson"] } as const;
  const result = await ctx.tools.run(request);
  const output = result.code <= 1 ? parseJson(result.stdout) : undefined;
  const diagnostics = (output as { generalDiagnostics?: unknown } | undefined)?.generalDiagnostics;
  if (!Array.isArray(diagnostics)) return [toolFailed(target, "pyright", result)];
  return (diagnostics as PyrightDiagnostic[])
    .filter((d) => d.severity !== "information")
    .map((d) =>
      codeFinding(target, {
        level: d.severity === "error" ? "error" : "hint",
        rule: `pyright/${d.rule ?? d.severity}`,
        message: d.message,
        file: d.file === undefined ? undefined : toRepoPath(ctx.cwd, target.dir, d.file),
        line: d.range === undefined ? undefined : d.range.start.line + 1,
        fix: TYPE_FIX,
      }),
    );
}

/** Ruff lint and format, and mypy or pyright, all run through `uv run` (SPEC §6.1, §5.2). */
export const pythonChecker: CodeChecker = {
  language: "python",
  async check(target, ctx) {
    const findings: Finding[] = [];
    if (target.categories.has("lint")) findings.push(...(await lint(target, ctx)));
    if (target.categories.has("format")) findings.push(...(await format(target, ctx)));
    if (target.categories.has("typecheck")) {
      const usePyright = target.effective["typecheck.tool"] === "pyright";
      findings.push(...(await (usePyright ? pyright(target, ctx) : mypy(target, ctx))));
    }
    return findings;
  },
};
