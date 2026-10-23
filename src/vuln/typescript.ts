import { isRecord, mirrorOf, noMirror, parseJson, scanFailed, scanFinding, str } from "./support.ts";
import type { ScanResult, Vuln, VulnScanner, VulnSeverity, VulnTarget } from "./types.ts";

const SEVERITY: Readonly<Record<string, VulnSeverity>> = {
  info: "info",
  low: "low",
  moderate: "moderate",
  high: "high",
  critical: "critical",
};

/** The GHSA id at the end of an advisory URL such as https://github.com/advisories/GHSA-xxxx-xxxx-xxxx. */
const ghsa = (url: string | undefined) => /\/(GHSA-[\w-]+)$/.exec(url ?? "")?.[1];

function fixedIn(entry: Record<string, unknown>): string | undefined {
  const fix = entry.fixAvailable;
  if (!isRecord(fix)) return undefined;
  const name = str(fix.name);
  const version = str(fix.version);
  return name === undefined || version === undefined ? undefined : `${name}@${version}`;
}

/**
 * The advisories in an `npm audit --json` report (auditReportVersion 2). A package listed only because one of its
 * dependencies is vulnerable (`via` holds package names) adds nothing; each advisory is reported once.
 */
function advisories(report: Record<string, unknown>): Vuln[] {
  const packages = isRecord(report.vulnerabilities) ? Object.values(report.vulnerabilities) : [];
  const all = packages.filter(isRecord).flatMap((entry) => {
    const via: unknown[] = Array.isArray(entry.via) ? entry.via : [];
    return via.filter(isRecord).flatMap((advisory) => advisoryOf(entry, advisory) ?? []);
  });
  return [...new Map(all.reverse().map((v) => [v.id, v])).values()].reverse();
}

/** The advised package and its vulnerable range, such as "lodash <4.17.19". */
function affectedRange(entry: Record<string, unknown>, via: Record<string, unknown>): string {
  const name = str(via.name) ?? str(entry.name) ?? "?";
  const range = str(via.range);
  return range === undefined ? name : `${name} ${range}`;
}

/** One advisory (a `via` object) of a package entry, identified by its GHSA id, else npm's advisory number. */
function advisoryOf(entry: Record<string, unknown>, via: Record<string, unknown>): Vuln | undefined {
  const source = typeof via.source === "number" ? `npm-${String(via.source)}` : undefined;
  const id = ghsa(str(via.url)) ?? source;
  if (id === undefined) return undefined;
  const severity = SEVERITY[str(via.severity) ?? ""];
  const fix = fixedIn(entry);
  return {
    id,
    aliases: [],
    affects: affectedRange(entry, via),
    summary: str(via.title) ?? "",
    ...(severity === undefined ? {} : { severity }),
    ...(fix === undefined ? {} : { fixedIn: fix }),
  };
}

/**
 * npm could not get audit data from the mirror: Nexus answers the bulk endpoint only with Repository Firewall, and
 * npm's legacy endpoints are retired (SPEC §5.3). A hint, not an error.
 */
function unavailable(target: VulnTarget, error: Record<string, unknown>): ScanResult {
  const code = str(error.code) ?? "?";
  const summary = (str(error.summary) ?? "").split(/\r?\n/)[0] ?? "";
  return {
    vulns: [],
    findings: [
      scanFinding(
        target,
        "hint",
        "vuln/source-unavailable",
        `npm 鏡像的 audit bulk 端點無法使用（${code}${summary === "" ? "" : `：${summary}`}），這次沒有掃描 TypeScript 依賴的弱點`,
        "需要 Nexus ≥3.82 並啟用 Sonatype Repository Firewall 的 npm audit，以及 npm ≥8；請向 IT 確認",
      ),
    ],
  };
}

/** `npm audit --json` against the mirror's bulk endpoint (SPEC §5.3, §6.3); includes dev dependencies. */
export const typescriptScanner: VulnScanner = {
  language: "typescript",
  async scan(target, ctx) {
    const manager = target.effective["deps.manager"];
    if (manager !== undefined && manager !== "npm") {
      const message = `${typeof manager === "string" ? manager : "這個套件管理工具"} 的弱點掃描尚未支援，這次沒有掃描 TypeScript 依賴的弱點`;
      return {
        vulns: [],
        findings: [scanFinding(target, "hint", "vuln/unsupported", message, "改用 npm，或在 CI 另行掃描")],
      };
    }
    const mirror = mirrorOf(target, "mirrors.npm");
    if (mirror === undefined) return { vulns: [], findings: [noMirror(target, "mirrors.npm", "npm audit")] };
    if (!ctx.tools.manage) throw new Error("tool runner cannot run npm");
    const result = await ctx.tools.manage({
      language: "typescript",
      dir: target.dir,
      args: ["audit", "--json"],
      mirror,
    });
    const report = parseJson(result.stdout);
    if (!isRecord(report)) return { vulns: [], findings: [scanFailed(target, "npm audit --json", result)] };
    if (isRecord(report.error)) return unavailable(target, report.error);
    return { vulns: advisories(report), findings: [] };
  },
};
