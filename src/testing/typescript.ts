import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import {
  isRecord,
  jsonFromOutput,
  judgeCoverage,
  parseJson,
  readReport,
  reportMissing,
  testsFailed,
  testToolFailed,
  type CoverageMetric,
  type Measured,
} from "./coverage.ts";
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

const METRICS: readonly CoverageMetric[] = ["lines", "branches", "functions", "statements"];

/**
 * The run's arguments: tests with coverage, a JSON test report written to `report`, and an istanbul json-summary
 * written to `reportDir`. Both Vitest and Jest write the same Jest-style JSON report.
 */
function invocation(tool: "vitest" | "jest", reportDir: string, report: string): string[] {
  if (tool === "jest") {
    return [
      "--ci",
      "--coverage",
      "--coverageReporters=json-summary",
      `--coverageDirectory=${reportDir}`,
      "--json",
      `--outputFile=${report}`,
    ];
  }
  return [
    "run",
    "--coverage.enabled=true",
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${reportDir}`,
    "--reporter=json",
    `--outputFile.json=${report}`,
  ];
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** Whether a Jest-style JSON report has failures, and the failing tests' names; undefined when it is not one. */
function failures(report: unknown): { failed: boolean; names: string[] } | undefined {
  if (!isRecord(report) || typeof report.numFailedTests !== "number") return undefined;
  const names = records(report.testResults).flatMap((file) => {
    const failed = records(file.assertionResults).filter((a) => a.status === "failed");
    const named = failed.map((a) => text(a.fullName) || text(a.title));
    // A test file that fails to load has no failing assertions of its own.
    return named.length === 0 && file.status === "failed" ? [text(file.name)] : named;
  });
  const suites = typeof report.numFailedTestSuites === "number" ? report.numFailedTestSuites : 0;
  return { failed: report.numFailedTests > 0 || suites > 0, names: names.filter((n) => n !== "") };
}

/** The four totals of an istanbul json-summary. */
function summaryTotals(text: string | undefined): Measured[] | undefined {
  const summary = text === undefined ? undefined : parseJson(text);
  if (!isRecord(summary) || !isRecord(summary.total)) return undefined;
  const total = summary.total;
  return METRICS.flatMap((metric) => {
    const m = total[metric];
    if (!isRecord(m) || typeof m.covered !== "number" || typeof m.total !== "number") return [];
    return [{ metric, covered: m.covered, total: m.total }];
  });
}

/** Vitest (default) or Jest, with all four coverage totals held to `coverage.lines` (SPEC §6.3). */
export const typescriptTests: TestChecker = {
  language: "typescript",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const tool = target.effective["test.tool"] === "jest" ? "jest" : "vitest";
    // Separate paths: the coverage tool empties its directory before a run.
    const coverageDir = join(ctx.reportDir, "coverage");
    const reportFile = join(ctx.reportDir, "tests.json");
    const args = invocation(tool, coverageDir, reportFile);
    const result = await ctx.tools.run({ language: "typescript", tool, dir: target.dir, args });
    // Older versions without an output file print the report to stdout.
    const report = failures(parseJson((await readReport(reportFile)) ?? "") ?? jsonFromOutput(result.stdout));
    if (report === undefined) return [testToolFailed(target, tool, result)];
    const findings: Finding[] = [];
    const command = tool === "jest" ? "npx jest" : "npx vitest run";
    // A non-zero exit with no failing test comes from the tool's own coverage threshold; the CLI judges that below.
    if (report.failed) findings.push(testsFailed(target, command, report.names));
    const totals = summaryTotals(await readReport(join(coverageDir, "coverage-summary.json")));
    if (totals === undefined) {
      findings.push(
        reportMissing(target, "coverage-summary.json", `確認已安裝 ${tool} 的覆蓋率套件，並執行 ${command} --coverage`),
      );
    } else {
      findings.push(...judgeCoverage(target, totals));
    }
    return findings;
  },
};
