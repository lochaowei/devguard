import { FIX_LAYERS, runCheck, type CheckLayer, type CheckOptions } from "../check.ts";
import { renderText } from "../report/render.ts";
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
  const result = await runCheck(options, layers);
  if (!result.resolution?.standard && result.findings.some((f) => f.level === "error")) {
    options.io.write(renderText(result, false));
    return 1;
  }
  const plan = await planChanges(
    options.cwd,
    result.findings.flatMap((f) => f.repairs ?? []),
  );
  return previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: () => applyPlan(options.cwd, plan),
  });
}
