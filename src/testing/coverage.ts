import type { Finding } from "../report/finding.ts";
import type { ToolResult } from "../tools/runner.ts";
import type { TestTarget } from "./types.ts";
import { readIfExists } from "../shared/fs.ts";

/** The coverage measures the standard can hold to a threshold (SPEC §6). */
export type CoverageMetric = "lines" | "branches" | "functions" | "statements";

const METRIC_LABEL: Readonly<Record<CoverageMetric, string>> = {
  lines: "行覆蓋率",
  branches: "分支覆蓋率",
  functions: "函式覆蓋率",
  statements: "陳述式覆蓋率",
};

/** One measured total: how many of `total` items the tests covered, or only the percentage a tool printed. */
export type Measured = { metric: CoverageMetric } & ({ covered: number; total: number } | { percent: number });

/** A finding in the code layer, attributed to the target's component. */
export function testFinding(target: TestTarget, rule: string, message: string, fix: string): Finding {
  return { level: "error", layer: "code", rule, message, component: target.component, fix };
}

const where = (target: TestTarget) => (target.dir === "" ? "repo 根目錄" : target.dir);

/** Failing tests: reported apart from coverage (SPEC §7.1). `failed` names the failing tests when known. */
export function testsFailed(target: TestTarget, command: string, failed: readonly string[]): Finding {
  const shown = failed.slice(0, 5).join("、");
  const more = failed.length > 5 ? ` 等 ${String(failed.length)} 項` : "";
  const message = failed.length === 0 ? "測試失敗" : `測試失敗：${shown}${more}`;
  return testFinding(target, "test/failed", message, `在 ${where(target)} 執行 ${command} 查看失敗的測試`);
}

/** The test run did not produce a usable result (crash, bad configuration, missing plugin). */
export function testToolFailed(target: TestTarget, tool: string, result: ToolResult): Finding {
  const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-5).join("\n");
  return testFinding(
    target,
    "test/tool-failed",
    `${tool} 執行失敗（exit ${String(result.code)}）${output === "" ? "" : `：${output}`}`,
    `在 ${where(target)} 直接執行 ${tool} 查看完整訊息`,
  );
}

/** The tests ran but left no coverage report to judge; `detail` is what the reporting tool said. */
export function reportMissing(target: TestTarget, report: string, fix: string, detail = ""): Finding {
  const why = detail.trim() === "" ? "" : `（${detail.trim().split(/\r?\n/).slice(-3).join(" ")}）`;
  return testFinding(target, "coverage/no-report", `找不到覆蓋率報告 ${report}，無法判定覆蓋率${why}`, fix);
}

const pct = (n: number) => `${String(Math.floor(n * 10) / 10)}%`;

/**
 * Each measured total against the threshold in force; a total with nothing to cover (e.g. no branches) passes.
 * The CLI judges coverage itself rather than through the tools' own thresholds (SPEC §6).
 */
export function judgeCoverage(target: TestTarget, measured: readonly Measured[]): Finding[] {
  const findings: Finding[] = [];
  for (const m of measured) {
    if ("total" in m && m.total <= 0) continue;
    const percent = "total" in m ? (m.covered / m.total) * 100 : m.percent;
    if (percent >= target.threshold) continue;
    const counts = "total" in m ? `（${String(m.covered)}/${String(m.total)}）` : " ";
    const declared = target.deviation ? "（宣告的偏離值）" : "";
    findings.push(
      testFinding(
        target,
        `coverage/${m.metric}`,
        `${METRIC_LABEL[m.metric]} ${pct(percent)}${counts}低於門檻 ${String(target.threshold)}%${declared}`,
        "補上測試；若暫時無法達到，在 .devguard.yaml 以 {value, reason, until} 放寬 coverage.lines",
      ),
    );
  }
  return findings;
}

/** A report file's text, or undefined when the run did not write it. */
export const readReport = readIfExists;

/** JSON text as a value, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The JSON object a tool printed to stdout, skipping lines the test code itself printed around it.
 * Tries the whole output first, then each line that starts an object.
 */
export function jsonFromOutput(stdout: string): unknown {
  const whole = parseJson(stdout.trim());
  if (whole !== undefined) return whole;
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.startsWith("{")) continue;
    const value = parseJson(lines.slice(i).join("\n").trim()) ?? parseJson(lines[i] ?? "");
    if (value !== undefined) return value;
  }
  return undefined;
}

export { isRecord } from "../shared/guards.ts";
