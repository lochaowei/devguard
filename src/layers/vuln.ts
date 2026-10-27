import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueInForce, type ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles } from "../repo/files.ts";
import { ignoredInForce, judgeVulns } from "../vuln/judge.ts";
import { VULN_SCANNERS } from "../vuln/registry.ts";
import type { VulnTarget } from "../vuln/types.ts";
import { filesInScope, type CheckLayer, type LayerContext } from "./types.ts";

function toTarget(ctx: LayerContext, component: ResolvedComponent): VulnTarget {
  const global = Object.fromEntries(Object.entries(ctx.resolution?.global ?? {}).map(([k, i]) => [k, i.value]));
  const own = Object.fromEntries(Object.entries(component.effective).map(([k, item]) => [k, item.value]));
  return {
    component: component.name,
    dir: component.dir,
    language: component.language,
    effective: { ...global, ...own },
    ignored: ignoredInForce(component.effective["deps.ignoredVulns"]?.value, ctx.today),
  };
}

/** Components with `deps.vulnScan: true` that own at least one of the files in scope. */
async function componentsToScan(ctx: LayerContext): Promise<ResolvedComponent[]> {
  const components = (ctx.resolution?.components ?? []).filter((c) => c.effective["deps.vulnScan"]?.value === true);
  const owned = assignFiles(components, await filesInScope(ctx));
  const dirs = new Set(owned.flatMap((o) => (o.owner.kind === "component" ? [o.owner.component] : [])));
  return components.filter((c) => dirs.has(c));
}

/**
 * Vulnerability scans (SPEC §5.3): off by default; when a component turns `deps.vulnScan` on, they run with
 * `check --full`, which pre-push and CI run. The CLI judges the results against `deps.vulnFailOn` and
 * `deps.ignoredVulns`; the data comes only from internal mirrors.
 */
export const vulnLayer: CheckLayer = {
  id: "vuln",
  async run(ctx: LayerContext) {
    const standard = ctx.resolution?.standard;
    if (!ctx.scope.full || ctx.scope.only !== undefined || !standard) return { findings: [] };
    const findings: Finding[] = [];
    for (const component of await componentsToScan(ctx)) {
      const scanner = VULN_SCANNERS[component.language];
      if (!scanner) continue;
      const target = toTarget(ctx, component);
      const workDir = await mkdtemp(join(tmpdir(), "devguard-vuln-"));
      try {
        const result = await scanner.scan(target, { cwd: ctx.cwd, tools: ctx.tools, workDir });
        const failOn = valueInForce(
          standard.languages[component.language]["deps.vulnFailOn"]?.value,
          component.effective["deps.vulnFailOn"],
        );
        findings.push(...result.findings, ...judgeVulns(target, result.vulns, String(failOn)));
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
    return { findings };
  },
};
