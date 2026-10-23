import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import { parseXmlText } from "../xml/parse.ts";
import {
  judgeCoverage,
  readReport,
  reportMissing,
  testsFailed,
  testToolFailed,
  type CoverageMetric,
  type Measured,
} from "./coverage.ts";
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

interface Build {
  /** Wrapper arguments: run the tests, then write the JaCoCo XML report. */
  args: string[];
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
  args: ["-B", "-Dmaven.test.failure.ignore=true", "test", "jacoco:report"],
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
  args: ["test", "jacocoTestReport", "--continue"],
  report: "build/reports/jacoco/test/jacocoTestReport.xml",
  wrapper: "gradlew",
  command: "gradlew test",
  setup: "套用 jacoco plugin，並在 jacocoTestReport 設定 reports { xml.required = true }",
  failures(stdout) {
    const names = [...stdout.matchAll(/^(\S.* > .+) FAILED\r?$/gm)].map((m) => m[1] ?? "");
    return { failed: names.length > 0, names };
  },
};

/** Maven when the component has a pom.xml, Gradle when it has a build script, otherwise what the declaration says. */
async function buildOf(target: TestTarget, ctx: TestContext): Promise<Build> {
  const has = async (f: string) => (await readReport(join(ctx.cwd, target.dir, f))) !== undefined;
  if (await has("pom.xml")) return MAVEN;
  if ((await has("build.gradle")) || (await has("build.gradle.kts"))) return GRADLE;
  return target.effective["build.tool"] === "gradle" ? GRADLE : MAVEN;
}

const COUNTERS: Readonly<Record<string, CoverageMetric>> = { LINE: "lines", BRANCH: "branches" };

/** LINE and BRANCH at BUNDLE level: the counters directly under <report> (SPEC §6.4). */
function bundleCounters(text: string | undefined): Measured[] | undefined {
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

/** JUnit 5 through the project's build wrapper, with JaCoCo LINE and BRANCH held to `coverage.lines`. */
export const javaTests: TestChecker = {
  language: "java",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const build = await buildOf(target, ctx);
    const report = join(ctx.cwd, target.dir, build.report);
    // A report from an earlier build must not pass for this one.
    await rm(report, { force: true });
    const result = await ctx.tools.run({ language: "java", tool: build.wrapper, dir: target.dir, args: build.args });
    const { failed, names } = build.failures(result.stdout);
    if (result.code !== 0 && !failed) return [testToolFailed(target, build.command, result)];
    const findings: Finding[] = [];
    if (failed) findings.push(testsFailed(target, build.command, names));
    const measured = bundleCounters(await readReport(report));
    if (measured === undefined) findings.push(reportMissing(target, target.dir + build.report, build.setup));
    else findings.push(...judgeCoverage(target, measured));
    return findings;
  },
};
