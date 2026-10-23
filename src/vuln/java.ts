import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IgnoredVuln } from "../standard/types.ts";
import { isRecord, mirrorOf, noMirror, parseJson, scanFailed, scanFinding, str } from "./support.ts";
import type { Vuln, VulnScanner, VulnSeverity } from "./types.ts";

const xmlText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * `deps.ignoredVulns` as a Dependency-Check suppression file (SPEC §6.4): a CVE id goes in `<cve>`, any other id
 * (GHSA...) in `<vulnerabilityName>`; `until` makes Dependency-Check itself stop suppressing after that date.
 */
export function suppressionFile(ignored: readonly IgnoredVuln[]): string {
  const entries = ignored.map((i) => {
    const match = /^CVE-/.test(i.id)
      ? `<cve>${xmlText(i.id)}</cve>`
      : `<vulnerabilityName>${xmlText(i.id)}</vulnerabilityName>`;
    const until = i.until === undefined ? "" : ` until="${xmlText(i.until)}Z"`;
    return `  <suppress${until}>\n    <notes>${xmlText(i.reason ?? "")}</notes>\n    ${match}\n  </suppress>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- 由 devguard 產生：deps.ignoredVulns -->",
    '<suppressions xmlns="https://jeremylong.github.io/DependencyCheck/dependency-suppression.1.3.xsd">',
    ...entries,
    "</suppressions>",
    "",
  ].join("\n");
}

/** CVSS score bands: 9+ critical, 7+ high (the standard's "CVSS 7"), 4+ moderate, above 0 low. */
function bySeverityScore(score: number): VulnSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return score > 0 ? "low" : "info";
}

const BY_NAME: Readonly<Record<string, VulnSeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "moderate",
  MODERATE: "moderate",
  LOW: "low",
  INFO: "info",
};

function severityOf(v: Record<string, unknown>): VulnSeverity | undefined {
  const v3 = isRecord(v.cvssv3) ? v.cvssv3.baseScore : undefined;
  const v2 = isRecord(v.cvssv2) ? v.cvssv2.score : undefined;
  const score = typeof v3 === "number" ? v3 : v2;
  if (typeof score === "number") return bySeverityScore(score);
  return BY_NAME[(str(v.severity) ?? "").toUpperCase()];
}

/** The vulnerabilities in Dependency-Check's JSON report, per dependency file. */
function reportedVulns(report: unknown): Vuln[] | undefined {
  if (!isRecord(report) || !Array.isArray(report.dependencies)) return undefined;
  return report.dependencies.flatMap((dep): Vuln[] => {
    if (!isRecord(dep) || !Array.isArray(dep.vulnerabilities)) return [];
    const affects = str(dep.fileName) ?? "?";
    return dep.vulnerabilities.flatMap((v): Vuln[] => {
      const id = isRecord(v) ? str(v.name) : undefined;
      if (!isRecord(v) || id === undefined) return [];
      const severity = severityOf(v);
      const summary = (str(v.description) ?? "").split(/\r?\n/)[0] ?? "";
      return [{ id, aliases: [], affects, summary, ...(severity === undefined ? {} : { severity }) }];
    });
  });
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The NVD data feed URL template under the internal mirror; Dependency-Check fills `{0}` with the year. */
const datafeed = (base: string) => `${base.endsWith("/") ? base : `${base}/`}nvdcve-{0}.json.gz`;

/**
 * OWASP Dependency-Check through the Maven wrapper (SPEC §5.3, §6.4), reading NVD only from the internal mirror.
 * Sources that would go out to the internet (OSS Index, Node Audit, CISA KEV, RetireJS, hosted suppressions) are off.
 */
export const javaScanner: VulnScanner = {
  language: "java",
  async scan(target, ctx) {
    if (target.effective["build.tool"] === "gradle") {
      const message = "Gradle 元件的弱點掃描尚未支援，這次沒有掃描 Java 依賴的弱點";
      return {
        vulns: [],
        findings: [
          scanFinding(target, "hint", "vuln/unsupported", message, "在 CI 以 dependency-check-gradle 另行掃描"),
        ],
      };
    }
    const nvd = mirrorOf(target, "mirrors.nvd");
    if (nvd === undefined) return { vulns: [], findings: [noMirror(target, "mirrors.nvd", "Dependency-Check")] };
    const suppression = join(ctx.workDir, "dependency-check-suppression.xml");
    await writeFile(suppression, suppressionFile(target.ignored));
    const result = await ctx.tools.run({
      language: "java",
      tool: "mvnw",
      dir: target.dir,
      args: [
        "-B",
        "-ntp",
        "org.owasp:dependency-check-maven:check",
        "-Dformat=JSON",
        `-Dodc.outputDirectory=${ctx.workDir}`,
        `-DsuppressionFile=${suppression}`,
        `-DnvdDatafeedUrl=${datafeed(nvd)}`,
        "-DossindexAnalyzerEnabled=false",
        "-DnodeAuditAnalyzerEnabled=false",
        "-DknownExploitedEnabled=false",
        "-DretireJsAnalyzerEnabled=false",
        "-DhostedSuppressionsEnabled=false",
      ],
    });
    const report = result.code === 0 ? await readText(join(ctx.workDir, "dependency-check-report.json")) : undefined;
    const vulns = report === undefined ? undefined : reportedVulns(parseJson(report));
    if (vulns === undefined)
      return { vulns: [], findings: [scanFailed(target, "mvnw dependency-check:check", result)] };
    return { vulns, findings: [] };
  },
};
