import { join } from "node:path";
import { isRecord, mirrorOf, noMirror, parseJson, scanFailed, scanFinding, str, strings } from "./support.ts";
import type { Vuln, VulnScanner } from "./types.ts";

/** The vulnerabilities in a `pip-audit -f json` report; older pip-audit prints the dependency list alone. */
function auditedVulns(report: unknown): Vuln[] | undefined {
  const deps = isRecord(report) ? report.dependencies : report;
  if (!Array.isArray(deps)) return undefined;
  return deps.flatMap((dep): Vuln[] => {
    if (!isRecord(dep) || !Array.isArray(dep.vulns)) return [];
    const affects = `${str(dep.name) ?? "?"}@${str(dep.version) ?? "?"}`;
    return dep.vulns.flatMap((v): Vuln[] => {
      const id = isRecord(v) ? str(v.id) : undefined;
      if (!isRecord(v) || id === undefined) return [];
      const fixedIn = strings(v.fix_versions)[0];
      return [
        {
          id,
          aliases: strings(v.aliases),
          affects,
          summary: (str(v.description) ?? "").split(/\r?\n/)[0] ?? "",
          ...(fixedIn === undefined ? {} : { fixedIn }),
        },
      ];
    });
  });
}

/**
 * The SPEC §5.3 alternative to pip-audit's default source (hard-wired to pypi.org): `uv export` the locked
 * requirements with hashes, then `pip-audit --disable-pip -s osv --osv-url <mirrors.osv>` (SPEC §6.1). pip-audit
 * reports no severity, so every vulnerability it finds fails.
 */
export const pythonScanner: VulnScanner = {
  language: "python",
  async scan(target, ctx) {
    const manager = target.effective["deps.manager"];
    if (manager !== undefined && manager !== "uv") {
      const message = `${typeof manager === "string" ? manager : "這個套件管理工具"} 的弱點掃描尚未支援，這次沒有掃描 Python 依賴的弱點`;
      return {
        vulns: [],
        findings: [scanFinding(target, "hint", "vuln/unsupported", message, "改用 uv，或在 CI 另行掃描")],
      };
    }
    const osv = mirrorOf(target, "mirrors.osv");
    if (osv === undefined) return { vulns: [], findings: [noMirror(target, "mirrors.osv", "pip-audit")] };
    const mirror = mirrorOf(target, "mirrors.pypi");
    if (mirror === undefined) return { vulns: [], findings: [noMirror(target, "mirrors.pypi", "uv export")] };
    if (!ctx.tools.manage) throw new Error("tool runner cannot run uv");
    const requirements = join(ctx.workDir, "requirements.txt");
    const exported = await ctx.tools.manage({
      language: "python",
      dir: target.dir,
      args: ["export", "--frozen", "--no-emit-project", "--format", "requirements.txt", "-o", requirements],
      mirror,
    });
    if (exported.code !== 0) return { vulns: [], findings: [scanFailed(target, "uv export --frozen", exported)] };
    const result = await ctx.tools.run({
      language: "python",
      tool: "pip-audit",
      dir: target.dir,
      args: [
        ...["-r", requirements, "--disable-pip", "-s", "osv", "--osv-url", osv, "-f", "json"],
        ...target.ignored.flatMap((i) => ["--ignore-vuln", i.id]),
      ],
    });
    const vulns = result.code <= 1 ? auditedVulns(parseJson(result.stdout)) : undefined;
    if (vulns === undefined) return { vulns: [], findings: [scanFailed(target, "pip-audit", result)] };
    return { vulns, findings: [] };
  },
};
