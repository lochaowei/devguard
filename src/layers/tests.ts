import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueInForce, type ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles } from "../repo/files.ts";
import type { Standard } from "../standard/types.ts";
import { coverageGateOff } from "../testing/coverage.ts";
import { TEST_CHECKERS } from "../testing/registry.ts";
import type { TestTarget } from "../testing/types.ts";
import { filesInScope, type CheckLayer, type LayerContext } from "./types.ts";

/** The coverage threshold a component is held to (`valueInForce`), and whether it is an accepted deviation. */
function thresholdInForce(standard: Standard, component: ResolvedComponent): { threshold: number; deviation: boolean } {
  const item = component.effective["coverage.lines"];
  const value = valueInForce(standard.languages[component.language]["coverage.lines"]?.value, item);
  return { threshold: typeof value === "number" ? value : 0, deviation: item?.accepted === true };
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
  const owned = assignFiles(components, await filesInScope(ctx));
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
        const target = toTarget(standard, component);
        const found = await checker.check(target, { cwd: ctx.cwd, tools: ctx.tools, reportDir });
        findings.push(
          ...(coverageGateOff(target.threshold) ? found.filter((f) => f.rule !== "coverage/no-report") : found),
        );
      } finally {
        await rm(reportDir, { recursive: true, force: true });
      }
    }
    return { findings };
  },
};
