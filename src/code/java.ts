import type { Finding, Level } from "../report/finding.ts";
import { descendants, parseXmlText, type XmlEl } from "../xml/parse.ts";
import { codeFinding, toolFailed, toRepoPath } from "./support.ts";
import type { CodeChecker, CodeCheckContext, CodeTarget } from "./types.ts";

function checkstyleLevel(severity: string | undefined): Level {
  return severity === "info" || severity === "ignore" ? "hint" : "error";
}

/** `com.puppycrawl...imports.UnusedImportsCheck` -> `UnusedImports`. */
function checkstyleRule(source: string | undefined): string {
  const name = (source ?? "").split(".").pop() ?? "";
  return name.replace(/Check$/, "") || "violation";
}

function lineOf(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function checkstyleFindings(target: CodeTarget, ctx: CodeCheckContext, root: XmlEl): Finding[] {
  return descendants(root, "file").flatMap((file) =>
    descendants(file, "error").map((e) =>
      codeFinding(target, {
        level: checkstyleLevel(e.attrs.severity),
        rule: `checkstyle/${checkstyleRule(e.attrs.source)}`,
        message: e.attrs.message ?? "",
        file: toRepoPath(ctx.cwd, target.dir, file.attrs.name ?? ""),
        line: lineOf(e.attrs.line),
        fix: "依 Checkstyle 訊息手動修改",
      }),
    ),
  );
}

function pmdFindings(target: CodeTarget, ctx: CodeCheckContext, root: XmlEl): Finding[] {
  const violations = descendants(root, "file").flatMap((file) =>
    descendants(file, "violation").map((v) =>
      codeFinding(target, {
        rule: `pmd/${v.attrs.rule ?? "violation"}`,
        message: v.text,
        file: toRepoPath(ctx.cwd, target.dir, file.attrs.name ?? ""),
        line: lineOf(v.attrs.beginline),
        fix: "依 PMD 訊息手動修改",
      }),
    ),
  );
  const errors = root.children
    .filter((e) => e.name === "error")
    .map((e) =>
      codeFinding(target, {
        rule: "pmd/processing-error",
        message: e.attrs.msg ?? "",
        file: toRepoPath(ctx.cwd, target.dir, e.attrs.filename ?? ""),
        fix: "依 PMD 訊息手動修改",
      }),
    );
  return [...violations, ...errors];
}

type ReportParser = (target: CodeTarget, ctx: CodeCheckContext, root: XmlEl) => Finding[];

/** Findings from one XML report the build wrote; a missing or broken report is itself a finding. */
async function readReport(
  target: CodeTarget,
  ctx: CodeCheckContext,
  tool: string,
  repoPath: string,
  parse: ReportParser,
): Promise<Finding[]> {
  const where = `在 ${target.dir === "" ? "repo 根目錄" : target.dir} 直接執行 build wrapper 查看完整訊息`;
  const text = await ctx.readText(repoPath);
  if (text === undefined) {
    return [codeFinding(target, { rule: "code/tool-failed", message: `找不到 ${tool} 報告 ${repoPath}`, fix: where })];
  }
  const parsed = parseXmlText(text);
  if (!parsed.ok) {
    const message = `${tool} 報告 ${repoPath} 無法解析（第 ${String(parsed.line)} 行）：${parsed.message}`;
    return [codeFinding(target, { rule: "code/tool-failed", message, fix: where })];
  }
  return parse(target, ctx, parsed.root);
}

type Build = "maven" | "gradle";

/** Maven when the component has a pom.xml, otherwise Gradle; the tool runner then picks the matching wrapper. */
async function buildOf(target: CodeTarget, ctx: CodeCheckContext): Promise<Build> {
  return (await ctx.readText(`${target.dir}pom.xml`)) === undefined ? "gradle" : "maven";
}

const GRADLE_REPORTS: readonly [string, string, ReportParser][] = [
  ["Checkstyle", "build/reports/checkstyle/main.xml", checkstyleFindings],
  ["Checkstyle", "build/reports/checkstyle/test.xml", checkstyleFindings],
  ["PMD", "build/reports/pmd/main.xml", pmdFindings],
  ["PMD", "build/reports/pmd/test.xml", pmdFindings],
];

/** Gradle fails the build on violations; with --continue every task still runs and writes its report. */
const GRADLE_VIOLATIONS = /rule violations were found/i;

/**
 * A source set without files writes no report, so missing Gradle reports are skipped. A failed build is read only
 * when it failed because of rule violations; otherwise the reports may be left over from an earlier build.
 */
async function gradleLint(target: CodeTarget, ctx: CodeCheckContext): Promise<Finding[]> {
  const result = await ctx.tools.run({
    language: "java",
    tool: "gradlew",
    dir: target.dir,
    args: ["checkstyleMain", "checkstyleTest", "pmdMain", "pmdTest", "--continue", "--console=plain", "-q"],
  });
  if (result.code !== 0 && !GRADLE_VIOLATIONS.test(result.stdout + result.stderr)) {
    return [toolFailed(target, "gradlew", result)];
  }
  const findings: Finding[] = [];
  for (const [tool, path, parse] of GRADLE_REPORTS) {
    const repoPath = target.dir + path;
    if ((await ctx.readText(repoPath)) !== undefined)
      findings.push(...(await readReport(target, ctx, tool, repoPath, parse)));
  }
  return findings;
}

async function lint(target: CodeTarget, ctx: CodeCheckContext, build: Build): Promise<Finding[]> {
  if (build === "gradle") return gradleLint(target, ctx);
  const result = await ctx.tools.run({
    language: "java",
    tool: "mvnw",
    dir: target.dir,
    args: [
      "-B",
      "-ntp",
      "checkstyle:check",
      "pmd:check",
      "-Dcheckstyle.failOnViolation=false",
      "-Dpmd.failOnViolation=false",
    ],
  });
  if (result.code !== 0) return [toolFailed(target, "mvnw", result)];
  return [
    ...(await readReport(target, ctx, "Checkstyle", `${target.dir}target/checkstyle-result.xml`, checkstyleFindings)),
    ...(await readReport(target, ctx, "PMD", `${target.dir}target/pmd.xml`, pmdFindings)),
  ];
}

const SPOTLESS_HEADER = "The following files had format violations:";

interface Unformatted {
  file: string;
  /** The diff lines below the file name, without their indentation. */
  diff: string[];
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The files Spotless lists after SPOTLESS_HEADER, each followed by a diff indented 4 columns further.
 * Maven prefixes every line with "[ERROR] "; the list ends at the first line indented less than a file name.
 */
function spotlessFiles(output: string): Unformatted[] {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/^\[ERROR\] ?/, ""));
  const body = lines.slice(lines.findIndex((l) => l.includes(SPOTLESS_HEADER)) + 1);
  if (body.length === lines.length) return [];
  const fileIndent = indentOf(body.find((l) => l.trim() !== "") ?? "");
  const files: Unformatted[] = [];
  for (const line of body) {
    const blank = line.trim() === "";
    if (!blank && indentOf(line) < fileIndent) break;
    if (!blank && indentOf(line) === fileIndent) files.push({ file: line.trim(), diff: [] });
    else files[files.length - 1]?.diff.push(line.slice(fileIndent + 4));
  }
  return files;
}

/** The first removed or added line of the first hunk (1 when the diff was cut off). */
function firstChangedLine(diff: readonly string[]): number {
  let cursor: number | undefined;
  for (const line of diff) {
    const hunk = /^@@ -(\d+)/.exec(line);
    if (hunk) cursor = Number(hunk[1]);
    else if (cursor !== undefined && (line.startsWith("-") || line.startsWith("+"))) return cursor;
    else if (cursor !== undefined) cursor++;
  }
  return 1;
}

async function format(target: CodeTarget, ctx: CodeCheckContext, build: Build): Promise<Finding[]> {
  const maven = build === "maven";
  const result = await ctx.tools.run({
    language: "java",
    tool: maven ? "mvnw" : "gradlew",
    dir: target.dir,
    args: maven ? ["-B", "-ntp", "spotless:check"] : ["spotlessCheck", "--console=plain", "-q"],
  });
  if (result.code === 0) return [];
  const files = spotlessFiles(`${result.stdout}\n${result.stderr}`);
  if (files.length === 0) return [toolFailed(target, maven ? "mvnw" : "gradlew", result)];
  return files.map(({ file, diff }) =>
    codeFinding(target, {
      rule: "spotless/format",
      message: "格式不符合 Spotless",
      file: toRepoPath(ctx.cwd, target.dir, file),
      line: firstChangedLine(diff),
    }),
  );
}

/** Spotless, Checkstyle and PMD through the project's Maven or Gradle wrapper (SPEC §6.4). */
export const javaChecker: CodeChecker = {
  language: "java",
  async check(target, ctx) {
    const findings: Finding[] = [];
    const build = await buildOf(target, ctx);
    if (target.categories.has("lint")) findings.push(...(await lint(target, ctx, build)));
    if (target.categories.has("format")) findings.push(...(await format(target, ctx, build)));
    // The build tools always check the whole component; findings outside the requested files are dropped.
    if (target.files === undefined) return findings;
    const wanted = new Set(target.files.map((f) => toRepoPath(ctx.cwd, target.dir, f)));
    return findings.filter((f) => f.file === undefined || wanted.has(f.file));
  },
  /** Spotless formats the whole component; Checkstyle and PMD have no automatic fixes. */
  async fixSteps(target, ctx) {
    const maven = (await buildOf(target, ctx)) === "maven";
    return [
      maven
        ? { tool: "mvnw", args: ["-B", "-ntp", "spotless:apply"], okUpTo: 0 }
        : { tool: "gradlew", args: ["spotlessApply", "--console=plain", "-q"], okUpTo: 0 },
    ];
  },
};
