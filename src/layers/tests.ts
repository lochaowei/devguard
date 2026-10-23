import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles } from "../repo/files.ts";
import type { Standard } from "../standard/types.ts";
import { TEST_CHECKERS } from "../testing/registry.ts";
import type { TestTarget } from "../testing/types.ts";
import { scopedFiles, type CheckLayer, type LayerContext } from "./types.ts";

/**
 * The coverage threshold a component is held to: its declared value when that is not looser or is an accepted
 * deviation, otherwise the standard's (the declaration layer already reports the unjustified widening).
 */
function thresholdInForce(standard: Standard, component: ResolvedComponent): { threshold: number; deviation: boolean } {
  const def = standard.languages[component.language]["coverage.lines"]?.value;
  const fallback = typeof def === "number" ? def : 0;
  const item: EffectiveItem | undefined = component.effective["coverage.lines"];
  if (typeof item?.value !== "number") return { threshold: fallback, deviation: false };
  if (item.accepted === true) return { threshold: item.value, deviation: true };
  const ok = item.status === "same" || item.status === "stricter";
  return { threshold: ok ? item.value : fallback, deviation: false };
}

function toTarget(standard: Standard, component: ResolvedComponent): TestTarget {
  return {
    component: component.name,
    dir: component.dir,
    language: component.language,
    effective: Object.fromEntries(Object.entries(component.effective).map(([k, item]) => [k, item.value])),
    ...thresholdInForce(standard, component),
  };
}

/** Components that own at least one of the files in scope; tests run on whole components only. */
async function componentsInScope(ctx: LayerContext): Promise<ResolvedComponent[]> {
  const components = ctx.resolution?.components ?? [];
  const owned = assignFiles(components, await scopedFiles(ctx));
  const dirs = new Set(owned.flatMap((o) => (o.owner.kind === "component" ? [o.owner.component] : [])));
  return components.filter((c) => dirs.has(c));
}

/** Tests and coverage (SPEC §6, §7.1): only with `check --full`, which pre-push and CI run. */
export const testsLayer: CheckLayer = {
  id: "tests",
  async run(ctx: LayerContext) {
    const standard = ctx.resolution?.standard;
    if (!ctx.scope.full || ctx.scope.only !== undefined || !standard) return { findings: [] };
    const findings: Finding[] = [];
    for (const component of await componentsInScope(ctx)) {
      const checker = TEST_CHECKERS[component.language];
      if (!checker) continue;
      const reportDir = await mkdtemp(join(tmpdir(), "devguard-tests-"));
      try {
        findings.push(
          ...(await checker.check(toTarget(standard, component), { cwd: ctx.cwd, tools: ctx.tools, reportDir })),
        );
      } finally {
        await rm(reportDir, { recursive: true, force: true });
      }
    }
    return { findings };
  },
};
