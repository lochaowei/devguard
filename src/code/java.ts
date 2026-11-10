import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import { descendants, parseXmlText, type XmlEl } from "../xml/parse.ts";
import { targetBuildTool, type BuildTool } from "../settings/java/build.ts";
import { isMavenMultiModule, mavenReportDirs } from "../settings/java/modules.ts";
import { gradleApplied, gradleReportDirs, listDirsIn } from "../settings/java/gradle-projects.ts";
import { readBuildPlugins, type JavaPlugin } from "../settings/java/plugins.ts";
import { codeFinding, toolFailed, toRepoPath } from "./support.ts";
import type { CodeChecker, CodeCheckContext, CodeTarget } from "./types.ts";

function lineOf(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
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

/** The component's build tool (`javaBuildTool`); the tool runner then runs the matching wrapper. */
function buildOf(target: CodeTarget, ctx: CodeCheckContext): Promise<BuildTool> {
  return targetBuildTool(target, ctx.readText);
}

/** PMD: how it runs through either wrapper and where it writes its reports. */
interface LintTool {
  plugin: "pmd";
  label: string;
  parse: ReportParser;
  mavenGoal: string;
  mavenFlag: string;
  /** The report in each Maven module's directory. */
  mavenReport: string;
  gradleTasks: readonly string[];
  gradleReports: readonly string[];
}

const LINT_TOOLS: readonly LintTool[] = [
  {
    plugin: "pmd",
    label: "PMD",
    parse: pmdFindings,
    mavenGoal: "pmd:check",
    mavenFlag: "-Dpmd.failOnViolation=false",
    mavenReport: "target/pmd.xml",
    gradleTasks: ["pmdMain", "pmdTest"],
    gradleReports: ["build/reports/pmd/main.xml", "build/reports/pmd/test.xml"],
  },
];

/** Gradle fails the build on violations; with --continue every task still runs and writes its report. */
const GRADLE_VIOLATIONS = /rule violations were found/i;

/**
 * One tool's Gradle tasks, run apart from the other tool's so that one failing leaves the other's findings (#98). A
 * source set without files writes no report, so missing reports are skipped. A failed build is read only when it
 * failed because of rule violations; otherwise the reports may be left over from an earlier build.
 */
async function gradleLint(
  target: CodeTarget,
  ctx: CodeCheckContext,
  tool: LintTool,
  dirs: readonly string[],
): Promise<Finding[]> {
  // A report from an earlier build must not pass for this one (#101).
  for (const dir of dirs) for (const path of tool.gradleReports) await rm(join(ctx.cwd, dir, path), { force: true });
  const result = await ctx.tools.run({
    language: "java",
    tool: "gradlew",
    dir: target.dir,
    args: [...tool.gradleTasks, "--continue", "--console=plain", "-q"],
  });
  if (result.code !== 0 && !GRADLE_VIOLATIONS.test(result.stdout + result.stderr)) {
    return [toolFailed(target, "gradlew", result)];
  }
  const findings: Finding[] = [];
  for (const dir of dirs) {
    for (const path of tool.gradleReports) {
      const repoPath = dir + path;
      if ((await ctx.readText(repoPath)) !== undefined)
        findings.push(...(await readReport(target, ctx, tool.label, repoPath, tool.parse)));
    }
  }
  return findings;
}

/** The given tools in one Maven run. */
async function mavenLint(target: CodeTarget, ctx: CodeCheckContext, tools: readonly LintTool[]): Promise<Finding[]> {
  // Plugin goals alone do not resolve sibling modules from the reactor; a lifecycle phase first does (#102).
  const multiModule = await isMavenMultiModule(ctx.readText, target.dir);
  const result = await ctx.tools.run({
    language: "java",
    tool: "mvnw",
    dir: target.dir,
    args: [
      "-B",
      "-ntp",
      ...(multiModule ? ["test-compile"] : []),
      ...tools.map((t) => t.mavenGoal),
      ...tools.map((t) => t.mavenFlag),
    ],
  });
  if (result.code !== 0) return [toolFailed(target, "mvnw", result)];
  // A multi-module build writes the reports in each module's target/ (SPEC §6.4).
  const findings: Finding[] = [];
  for (const dir of await mavenReportDirs(ctx.readText, target.dir)) {
    for (const tool of tools)
      findings.push(...(await readReport(target, ctx, tool.label, dir + tool.mavenReport, tool.parse)));
  }
  return findings;
}

type MayRun = (plugin: JavaPlugin) => boolean;

/**
 * Whether a tool may run: unless the build surely lacks its plugin (#98). When devguard cannot tell, or there is no
 * readable build file, it runs as before.
 */
async function pluginsOf(
  target: CodeTarget,
  ctx: CodeCheckContext,
  build: BuildTool,
  dirs: readonly string[],
): Promise<MayRun> {
  if (build === "gradle") {
    // A multi-project build may apply a plugin only in its subprojects (#101).
    const lacking = new Set<JavaPlugin>();
    for (const plugin of ["spotless", "pmd"] as const)
      if ((await gradleApplied(ctx.readText, dirs, plugin)) === "no") lacking.add(plugin);
    return (plugin) => !lacking.has(plugin);
  }
  const plugins = await readBuildPlugins(ctx.readText, target.dir, build);
  return (plugin) => plugins?.applied(plugin) !== "no";
}

/** A tool whose plugin the build lacks is not run; the settings check reports the missing plugin (#98). */
async function lint(
  target: CodeTarget,
  ctx: CodeCheckContext,
  build: BuildTool,
  mayRun: MayRun,
  dirs: readonly string[],
): Promise<Finding[]> {
  const tools = LINT_TOOLS.filter((t) => mayRun(t.plugin));
  if (tools.length === 0) return [];
  if (build === "maven") return mavenLint(target, ctx, tools);
  const findings: Finding[] = [];
  for (const tool of tools) findings.push(...(await gradleLint(target, ctx, tool, dirs)));
  return findings;
}

/** The Gradle projects that write their own reports (SPEC §4.1); only the component itself for Maven. */
async function gradleProjects(target: CodeTarget, ctx: CodeCheckContext, build: BuildTool): Promise<string[]> {
  return build === "gradle" ? gradleReportDirs(ctx.readText, listDirsIn(ctx.cwd), target.dir) : [target.dir];
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

async function format(target: CodeTarget, ctx: CodeCheckContext, build: BuildTool): Promise<Finding[]> {
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

/** Spotless and PMD through the project's Maven or Gradle wrapper (SPEC §6.4). */
export const javaChecker: CodeChecker = {
  language: "java",
  // No stdin mode: the build reads the files on disk.
  workingTreeTools(target) {
    const lint = target.categories.has("lint") ? ["PMD"] : [];
    return target.categories.has("format") ? ["Spotless", ...lint] : lint;
  },
  async check(target, ctx) {
    const findings: Finding[] = [];
    const build = await buildOf(target, ctx);
    const dirs = await gradleProjects(target, ctx, build);
    const mayRun = await pluginsOf(target, ctx, build, dirs);
    if (target.categories.has("lint")) findings.push(...(await lint(target, ctx, build, mayRun, dirs)));
    if (target.categories.has("format") && mayRun("spotless")) findings.push(...(await format(target, ctx, build)));
    // The build tools always check the whole component; findings outside the requested files are dropped.
    if (target.files === undefined) return findings;
    const wanted = new Set(target.files.map((f) => toRepoPath(ctx.cwd, target.dir, f)));
    return findings.filter((f) => f.file === undefined || wanted.has(f.file));
  },
  /** Spotless formats the whole component; PMD has no automatic fixes. */
  async fixSteps(target, ctx) {
    const build = await buildOf(target, ctx);
    const dirs = await gradleProjects(target, ctx, build);
    if (!(await pluginsOf(target, ctx, build, dirs))("spotless")) return [];
    const maven = build === "maven";
    return [
      maven
        ? { tool: "mvnw", args: ["-B", "-ntp", "spotless:apply"], okUpTo: 0 }
        : { tool: "gradlew", args: ["spotlessApply", "--console=plain", "-q"], okUpTo: 0 },
    ];
  },
};
