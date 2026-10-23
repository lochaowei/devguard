import { FIX_LAYERS, runCheck, type CheckLayer, type CheckOptions } from "../check.ts";
import { previewThenApply, type Interaction } from "./interaction.ts";
import { applyPlan, planChanges, renderPlan } from "./plan.ts";

export interface FixOptions extends CheckOptions {
  io: Interaction;
}

/**
 * `devguard fix` (SPEC §9): runs the config checks, plans the repairs their findings carry by file category, then
 * previews and applies them under the shared interaction rules. Returns the exit code.
 */
export async function runFix(options: FixOptions, layers: readonly CheckLayer[] = FIX_LAYERS): Promise<0 | 1> {
  const { findings } = await runCheck(options, layers);
  const plan = await planChanges(
    options.cwd,
    findings.flatMap((f) => f.repairs ?? []),
  );
  return previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: () => applyPlan(options.cwd, plan),
  });
}
