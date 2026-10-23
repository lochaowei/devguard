import { isRecord, mirrorOf, noMirror, parseJsonStream, scanFailed, str, strings } from "./support.ts";
import type { Vuln, VulnScanner } from "./types.ts";

type Details = Pick<Vuln, "aliases" | "summary">;

/** An `osv` message: the entry's id, aliases and summary. */
function osvEntry(message: Record<string, unknown>): [string, Details] | undefined {
  const osv = message.osv;
  const id = isRecord(osv) ? str(osv.id) : undefined;
  if (!isRecord(osv) || id === undefined) return undefined;
  return [id, { aliases: strings(osv.aliases), summary: str(osv.summary) ?? "" }];
}

/**
 * A `finding` message at symbol level: its first trace frame names the vulnerable function the code calls. Findings
 * at package or module level (imported, not called) are not reported, as in govulncheck's own text output.
 */
function calledFinding(message: Record<string, unknown>): Vuln | undefined {
  const finding = message.finding;
  if (!isRecord(finding) || !Array.isArray(finding.trace)) return undefined;
  const id = str(finding.osv);
  const frame: unknown = finding.trace[0];
  if (id === undefined || !isRecord(frame) || str(frame.function) === undefined) return undefined;
  const version = str(frame.version);
  const fixedIn = str(finding.fixed_version);
  return {
    id,
    aliases: [],
    summary: "",
    affects: `${str(frame.module) ?? "?"}${version === undefined ? "" : `@${version}`}`,
    ...(fixedIn === undefined ? {} : { fixedIn }),
  };
}

/** The called vulnerabilities, once each, with their OSV details. Go vulndb entries carry no severity. */
function calledVulns(messages: readonly unknown[]): Vuln[] {
  const records = messages.filter(isRecord);
  const details = new Map<string, Details>();
  for (const message of records) {
    const entry = osvEntry(message);
    if (entry) details.set(...entry);
  }
  const vulns = new Map<string, Vuln>();
  for (const vuln of records.flatMap((m) => calledFinding(m) ?? [])) {
    if (!vulns.has(vuln.id)) vulns.set(vuln.id, { ...vuln, ...details.get(vuln.id) });
  }
  return [...vulns.values()];
}

/** govulncheck in source mode, reading only the internal vulndb mirror (SPEC §5.3, §6.2). */
export const goScanner: VulnScanner = {
  language: "go",
  async scan(target, ctx) {
    const db = mirrorOf(target, "mirrors.govulndb");
    if (db === undefined) return { vulns: [], findings: [noMirror(target, "mirrors.govulndb", "govulncheck")] };
    const result = await ctx.tools.run({
      language: "go",
      tool: "govulncheck",
      dir: target.dir,
      args: ["-json", "-db", db, "./..."],
    });
    const messages = result.code === 0 ? parseJsonStream(result.stdout) : undefined;
    if (messages === undefined) return { vulns: [], findings: [scanFailed(target, "govulncheck -json", result)] };
    return { vulns: calledVulns(messages), findings: [] };
  },
};
