import type { Finding } from "../report/finding.ts";
import { SEVERITIES, type IgnoredVuln } from "../standard/types.ts";
import { scanFinding } from "./support.ts";
import type { Vuln, VulnSeverity, VulnTarget } from "./types.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The `deps.ignoredVulns` entries in force: id, a real reason and an until that has not passed (SPEC §4.2). Any other
 * entry ignores nothing; the declaration layer already reports it as an error, and its vulnerability fails again.
 */
export function ignoredInForce(value: unknown, today: string): IgnoredVuln[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): IgnoredVuln[] => {
    if (!isRecord(entry)) return [];
    const { id, reason, until } = entry;
    if (typeof id !== "string" || typeof reason !== "string" || typeof until !== "string") return [];
    if (reason.trim() === "" || reason.trimStart().startsWith("TODO")) return [];
    if (!DATE.test(until) || until < today) return [];
    return [{ id, reason, until }];
  });
}

/** Severity rank on the standard's scale; npm's `info` ranks with `any`. Unknown severity ranks above everything. */
function rank(severity: VulnSeverity | undefined): number {
  if (severity === undefined) return SEVERITIES.length;
  return severity === "info" ? 0 : SEVERITIES.indexOf(severity);
}

const SEVERITY_LABEL: Readonly<Record<VulnSeverity, string>> = {
  info: "資訊",
  low: "低",
  moderate: "中",
  high: "高",
  critical: "嚴重",
};

function describe(v: Vuln): string {
  const aliases = v.aliases.length > 0 ? `（${v.aliases.join("、")}）` : "";
  const severity = v.severity === undefined ? "" : `［${SEVERITY_LABEL[v.severity]}］`;
  const summary = v.summary.trim() === "" ? "" : `：${v.summary.trim()}`;
  return `${severity}${v.id}${aliases} 影響 ${v.affects}${summary}`;
}

function fixOf(v: Vuln): string {
  const upgrade = v.fixedIn === undefined ? "升級或移除受影響的依賴" : `將受影響的依賴升級到 ${v.fixedIn} 以上`;
  return `${upgrade}；若暫時無法處理，在 .devguard.yaml 的 deps.ignoredVulns 加入 {id: ${v.id}, reason, until}`;
}

/**
 * Judges the scanner's vulnerabilities (SPEC §5.3): those in `deps.ignoredVulns` (by id or alias) are skipped;
 * the rest at or above `failOn` are errors, those below it hints. A vulnerability without severity always fails.
 */
export function judgeVulns(target: VulnTarget, vulns: readonly Vuln[], failOn: string): Finding[] {
  const threshold = Math.max(0, SEVERITIES.indexOf(failOn as (typeof SEVERITIES)[number]));
  const ignored = new Set(target.ignored.map((i) => i.id));
  return vulns
    .filter((v) => !ignored.has(v.id) && !v.aliases.some((a) => ignored.has(a)))
    .map((v) =>
      rank(v.severity) >= threshold
        ? scanFinding(target, "error", "vuln/found", `已知弱點 ${describe(v)}`, fixOf(v))
        : scanFinding(target, "hint", "vuln/below-threshold", `已知弱點（低於門檻 ${failOn}）${describe(v)}`, fixOf(v)),
    );
}
