import type { Finding } from "../report/finding.ts";
import type { IgnoredVuln, Language } from "../standard/types.ts";
import type { ToolRunner } from "../tools/runner.ts";

/** A tool's severity, mapped onto the standard's levels; `info` is below `low` (npm). */
export type VulnSeverity = "info" | "low" | "moderate" | "high" | "critical";

/** One known vulnerability affecting a component's dependencies, as a scanner reported it. */
export interface Vuln {
  /** The scanner's id (GO-…, GHSA-…, PYSEC-…, CVE-…). */
  id: string;
  /** Other ids of the same vulnerability (CVE, GHSA); `deps.ignoredVulns` may name any of them. */
  aliases: readonly string[];
  /** The affected package or module, e.g. "google.golang.org/protobuf@v1.32.0". */
  affects: string;
  summary: string;
  /** Unknown for sources without severity (Go vulndb, pip-audit): such a vulnerability always fails. */
  severity?: VulnSeverity;
  /** The first fixed version, when known. */
  fixedIn?: string;
}

/** One component whose dependencies are scanned (SPEC §5.3). */
export interface VulnTarget {
  /** Component display name such as "svc/ (Go)". */
  component: string;
  /** Normalized, "" for the repo root, otherwise ending in "/". */
  dir: string;
  language: Language;
  /** Effective standard values for the component, plus the repo-wide `mirrors.*`. */
  effective: Readonly<Record<string, unknown>>;
  /** `deps.ignoredVulns` entries that are in force (reason given, until not passed). */
  ignored: readonly IgnoredVuln[];
}

export interface VulnContext {
  /** Repo root. */
  cwd: string;
  /** Throws ToolMissingError when a scanner is not installed; let it propagate (exit 2). */
  tools: ToolRunner;
  /** A fresh, empty, absolute directory for exported files and reports; removed after the run. */
  workDir: string;
}

/**
 * What a scan found: the vulnerabilities, which the layer judges against `deps.vulnFailOn` and `deps.ignoredVulns`,
 * and findings about the scan itself (tool failed, data source unavailable).
 */
export interface ScanResult {
  vulns: Vuln[];
  findings: Finding[];
}

/** Runs one language's vulnerability scanner. Register an implementation in VULN_SCANNERS (src/vuln/registry.ts). */
export interface VulnScanner {
  language: Language;
  scan(target: VulnTarget, ctx: VulnContext): Promise<ScanResult>;
}
