import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import { targetBuildTool, type BuildTool } from "../settings/java/build.ts";
import { mavenReportDirs } from "../settings/java/modules.ts";
import type { ReadText } from "../settings/java/modules.ts";
import { readBuildPlugins, type Applied } from "../settings/java/plugins.ts";
import { parseXmlText } from "../xml/parse.ts";
import {
  coverageGateOff,
  judgeCoverage,
  readReport,
  reportMissing,
  testsFailed,
  testToolFailed,
  type CoverageMetric,
  type Measured,
} from "./coverage.ts";
import type { ToolResult } from "../tools/runner.ts";
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

interface Build {
  /** Wrapper arguments: run the tests, then (with `report`) write the JaCoCo XML report. */
  args(report: boolean): string[];
  /** What a wrapper prints when the build does not have JaCoCo (#99): the fallback when the build file cannot tell. */
  noJacoco: RegExp;
  /** The JaCoCo XML report, relative to the component directory. */
  report: string;
  /** The wrapper, as named in messages. */
  wrapper: string;
  /** How to rerun the tests by hand. */
  command: string;
  /** What to set up when no report is written. */
  setup: string;
  /** Whether tests failed, and the names of those the build output lists. */
  failures(stdout: string): { failed: boolean; names: string[] };
}

const MAVEN: Build = {
  // Test failures must not stop the build, so that the coverage report is still written and judged on its own.
  args: (report) => ["-B", "-Dmaven.test.failure.ignore=true", "test", ...(report ? ["jacoco:report"] : [])],
  noJacoco: /No plugin found for prefix 'jacoco'/,
  report: "target/site/jacoco/jacoco.xml",
  wrapper: "mvnw",
  command: "mvnw test",
  setup: "在 pom.xml 加入 jacoco-maven-plugin（prepare-agent），並確認 mvnw test jacoco:report 會產生 jacoco.xml",
  failures(stdout) {
    const names = [...new Set([...stdout.matchAll(/^\[ERROR\] {2,}(\S+)/gm)].map((m) => m[1] ?? ""))];
    const counts = [...stdout.matchAll(/Tests run: \d+, Failures: (\d+), Errors: (\d+)/g)];
    return { failed: names.length > 0 || counts.some((m) => Number(m[1]) + Number(m[2]) > 0), names };
  },
};

const GRADLE: Build = {
  // --continue still writes the coverage report when tests fail.
  args: (report) => ["test", ...(report ? ["jacocoTestReport"] : []), "--continue"],
  noJacoco: /Task 'jacocoTestReport' not found/,
  report: "build/reports/jacoco/test/jacocoTestReport.xml",
  wrapper: "gradlew",
  command: "gradlew test",
  setup: "套用 jacoco plugin，並在 jacocoTestReport 設定 reports { xml.required = true }",
  failures(stdout) {
    const names = [...stdout.matchAll(/^(\S.* > .+) FAILED\r?$/gm)].map((m) => m[1] ?? "");
    return { failed: names.length > 0, names };
  },
};

const COUNTERS: Readonly<Record<string, CoverageMetric>> = { LINE: "lines", BRANCH: "branches" };

/** A JaCoCo counter: covered out of total. */
type Counted = Extract<Measured, { total: number }>;

/** LINE and BRANCH at BUNDLE level: the counters directly under <report> (SPEC §6.4). */
function bundleCounters(text: string | undefined): Counted[] | undefined {
  const parsed = text === undefined ? undefined : parseXmlText(text);
  if (!parsed?.ok || parsed.root.name !== "report") return undefined;
  return parsed.root.children.flatMap((el) => {
    const metric = el.name === "counter" ? COUNTERS[el.attrs.type ?? ""] : undefined;
    if (metric === undefined) return [];
    const missed = Number(el.attrs.missed);
    const covered = Number(el.attrs.covered);
    return [{ metric, covered, total: missed + covered }];
  });
}

/** The counters of every report that was written, added up per metric; undefined when none was. */
function addUp(reports: readonly (Counted[] | undefined)[]): Counted[] | undefined {
  const written = reports.filter((r) => r !== undefined);
  if (written.length === 0) return undefined;
  const totals = new Map<CoverageMetric, Counted>();
  for (const m of written.flat()) {
    const sum = totals.get(m.metric);
    totals.set(m.metric, sum ? { ...sum, covered: sum.covered + m.covered, total: sum.total + m.total } : { ...m });
  }
  return [...totals.values()];
}

interface Run {
  result: ToolResult;
  failed: boolean;
  names: string[];
  /** Whether the wrapper was asked for the JaCoCo report in the run that produced `result`. */
  withReport: boolean;
}

/**
 * Runs the wrapper, asking for the JaCoCo report when `withReport`. When the build file could not tell whether
 * JaCoCo is there and the wrapper says it is not, the tests run again without the report goal (#99).
 */
async function runBuild(build: Build, target: TestTarget, ctx: TestContext, withReport: boolean): Promise<Run> {
  const run = async (report: boolean): Promise<Run> => {
    const args = build.args(report);
    const result = await ctx.tools.run({ language: "java", tool: build.wrapper, dir: target.dir, args });
    return { result, withReport: report, ...build.failures(result.stdout) };
  };
  const first = await run(withReport);
  const noJacoco = build.noJacoco.test(`${first.result.stdout}\n${first.result.stderr}`);
  return withReport && first.result.code !== 0 && !first.failed && noJacoco ? run(false) : first;
}

/** The BUNDLE counters of the reports that were written, added up. */
async function measure(reports: readonly string[]): Promise<Counted[] | undefined> {
  return addUp(await Promise.all(reports.map(async (r) => bundleCounters(await readReport(r)))));
}

/** Whether the build applies JaCoCo, read from the build file; "unknown" when it cannot tell. */
async function jacocoApplied(read: ReadText, target: TestTarget, tool: BuildTool): Promise<Applied> {
  return (await readBuildPlugins(read, target.dir, tool))?.applied("jacoco") ?? "unknown";
}

/** The reports the build writes, removed: a report from an earlier build must not pass for this one. */
async function staleReports(build: Build, target: TestTarget, ctx: TestContext): Promise<string[]> {
  const read = (p: string) => readReport(join(ctx.cwd, p));
  // A multi-module Maven build writes one report per module; their BUNDLE counters add up.
  const dirs = build === MAVEN ? await mavenReportDirs(read, target.dir) : [target.dir];
  const reports = dirs.map((d) => join(ctx.cwd, d, build.report));
  for (const report of reports) await rm(report, { force: true });
  return reports;
}

/** JUnit 5 through the project's build wrapper, with JaCoCo LINE and BRANCH held to `coverage.lines`. */
export const javaTests: TestChecker = {
  language: "java",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const read = (p: string) => readReport(join(ctx.cwd, p));
    const tool = await targetBuildTool(target, read);
    const build = tool === "gradle" ? GRADLE : MAVEN;
    const gateOff = coverageGateOff(target.threshold);
    // Without JaCoCo the report goal ends the build before any test runs (#99).
    const wantReport = !gateOff && (await jacocoApplied(read, target, tool)) !== "no";
    const reports = await staleReports(build, target, ctx);
    const { result, failed, names, withReport } = await runBuild(build, target, ctx, wantReport);
    if (result.code !== 0 && !failed) return [testToolFailed(target, build.command, result)];
    const findings: Finding[] = failed ? [testsFailed(target, build.command, names)] : [];
    if (gateOff) return findings;
    const measured = withReport ? await measure(reports) : undefined;
    if (measured === undefined) findings.push(reportMissing(target, target.dir + build.report, build.setup));
    else findings.push(...judgeCoverage(target, measured));
    return findings;
  },
};
