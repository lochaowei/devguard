import type { Finding } from "../report/finding.ts";
import type { ToolResult } from "../tools/runner.ts";
import { codeFinding, runBatched, toolFailed, toRepoPath } from "./support.ts";
import type { CodeChecker, CodeCheckContext, CodeTarget } from "./types.ts";

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
}

interface EslintFile {
  filePath: string;
  messages: EslintMessage[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function eslintFindings(target: CodeTarget, ctx: CodeCheckContext, result: ToolResult): Finding[] {
  const files = result.code <= 1 ? parseJson(result.stdout) : undefined;
  if (!Array.isArray(files)) return [toolFailed(target, "eslint", result)];
  return (files as EslintFile[]).flatMap((f) =>
    f.messages.map((m) =>
      codeFinding(target, {
        level: m.severity >= 2 ? "error" : "hint",
        rule: `eslint/${m.ruleId ?? "parse-error"}`,
        message: m.message,
        file: toRepoPath(ctx.cwd, target.dir, f.filePath),
        line: m.line,
      }),
    ),
  );
}

async function lint(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const request = { language: "typescript", tool: "eslint", dir: target.dir } as const;
  const results = await runBatched(ctx.tools, request, ["--format", "json", "--no-warn-ignored"], target.files);
  return results.flatMap((r) => eslintFindings(target, ctx, r));
}

/** 1-based number of the first line where `actual` and `expected` differ (1 when they are equal). */
function firstDifferentLine(actual: string, expected: string): number {
  const a = actual.split("\n");
  const b = expected.split("\n");
  const i = a.findIndex((line, n) => line !== b[n]);
  return i === -1 ? Math.min(a.length, b.length) : i + 1;
}

/** Prettier only lists unformatted files; formatting each one again locates the first changed line. */
async function prettierLine(target: CodeTarget, ctx: CodeCheckContext, file: string, repoPath: string) {
  const [original, formatted] = await Promise.all([
    ctx.readText(repoPath),
    ctx.tools.run({ language: "typescript", tool: "prettier", dir: target.dir, args: [file] }),
  ]);
  if (original === undefined || formatted.code !== 0) return 1;
  return firstDifferentLine(original, formatted.stdout);
}

async function format(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const request = { language: "typescript", tool: "prettier", dir: target.dir } as const;
  const findings: Finding[] = [];
  for (const result of await runBatched(ctx.tools, request, ["--list-different"], target.files)) {
    if (result.code > 1) {
      findings.push(toolFailed(target, "prettier", result));
      continue;
    }
    for (const listed of result.stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
      const file = listed.trim().replace(/\\/g, "/");
      const repoPath = toRepoPath(ctx.cwd, target.dir, file);
      const line = await prettierLine(target, ctx, file, repoPath);
      findings.push(
        codeFinding(target, { rule: "prettier/format", message: "格式不符合 Prettier", file: repoPath, line }),
      );
    }
  }
  return findings;
}

const TSC_FILE_ERROR = /^(.+)\((\d+),\d+\): error (TS\d+): (.*)$/;
const TSC_GLOBAL_ERROR = /^error (TS\d+): (.*)$/;

function tscFinding(target: CodeTarget, ctx: CodeCheckContext, line: string): Finding | undefined {
  const fix = "手動修正型別錯誤";
  const inFile = TSC_FILE_ERROR.exec(line);
  if (inFile) {
    const [, file = "", lineNo, code = "", message = ""] = inFile;
    const repoPath = toRepoPath(ctx.cwd, target.dir, file);
    return codeFinding(target, { rule: `tsc/${code}`, message, file: repoPath, line: Number(lineNo), fix });
  }
  const global = TSC_GLOBAL_ERROR.exec(line);
  if (global) return codeFinding(target, { rule: `tsc/${global[1] ?? ""}`, message: global[2] ?? "", fix });
  return undefined;
}

/** `tsc --noEmit` always checks the whole project: it reads tsconfig.json and cannot take a file list. */
async function typecheck(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const args = ["--noEmit", "--pretty", "false"];
  const result = await ctx.tools.run({ language: "typescript", tool: "tsc", dir: target.dir, args });
  if (result.code === 0) return [];
  const findings = result.stdout.split(/\r?\n/).flatMap((line) => tscFinding(target, ctx, line) ?? []);
  return findings.length > 0 ? findings : [toolFailed(target, "tsc", result)];
}

/** `::error title=lint/x/y,file=src/a.ts,line=4,...::message` from `biome --reporter=github`. */
const GITHUB_ANNOTATION = /^::(error|warning|notice) (.*?)::(.*)$/;

function annotationFields(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split(",").map((pair) => {
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

async function biome(target: CodeTarget, ctx: CodeCheckContext, command: "lint" | "format"): Promise<Finding[]> {
  const request = { language: "typescript", tool: "biome", dir: target.dir } as const;
  const results = await runBatched(ctx.tools, request, [command, "--reporter=github"], target.files);
  return results.flatMap((result) => {
    const findings = result.stdout.split(/\r?\n/).flatMap((text) => {
      const m = GITHUB_ANNOTATION.exec(text);
      if (!m) return [];
      const fields = annotationFields(m[2] ?? "");
      const file = fields.file === undefined ? undefined : toRepoPath(ctx.cwd, target.dir, fields.file);
      return [
        codeFinding(target, {
          level: m[1] === "error" ? "error" : "hint",
          rule: `biome/${fields.title ?? command}`,
          message: m[3] ?? "",
          file,
          line: fields.line === undefined ? undefined : Number(fields.line),
        }),
      ];
    });
    return findings.length === 0 && result.code !== 0 ? [toolFailed(target, "biome", result)] : findings;
  });
}

/** ESLint + Prettier (or Biome) and `tsc --noEmit`, run from the component's node_modules (SPEC §6.3). */
export const typescriptChecker: CodeChecker = {
  language: "typescript",
  async check(target, ctx) {
    const findings: Finding[] = [];
    const useBiome = target.effective["lint.tool"] === "biome";
    if (target.categories.has("lint")) {
      findings.push(...(await (useBiome ? biome(target, ctx, "lint") : lint(target, ctx))));
    }
    if (target.categories.has("format")) {
      findings.push(...(await (useBiome ? biome(target, ctx, "format") : format(target, ctx))));
    }
    if (target.categories.has("typecheck")) findings.push(...(await typecheck(target, ctx)));
    return findings;
  },
};
