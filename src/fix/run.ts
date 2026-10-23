import { FIX_LAYERS, runCheck, type CheckLayer, type CheckOptions } from "../check.ts";
import { planFixHooks } from "../hooks/install.ts";
import type { Exec } from "../process/exec.ts";
import { previewThenApply, type Interaction } from "./interaction.ts";
import { applyPlan, planChanges, renderPlan, type ChangePlan } from "./plan.ts";

export interface FixOptions extends CheckOptions {
  io: Interaction;
  /** Runs git (where the hooks live); defaults to the real one. */
  exec?: Exec;
}

/** Runs the config checks and plans the repairs their findings carry, by file category. Writes nothing. */
export async function planConfigFix(
  options: CheckOptions,
  layers: readonly CheckLayer[] = FIX_LAYERS,
): Promise<ChangePlan> {
  const { findings } = await runCheck(options, layers);
  return planChanges(
    options.cwd,
    findings.flatMap((f) => f.repairs ?? []),
  );
}

/**
 * `devguard fix` (SPEC §9): runs the config checks, plans the repairs their findings carry by file category, adds
 * devguard's own git hooks that were modified, then previews and applies them under the shared interaction rules.
 * Returns the exit code.
 */
export async function runFix(options: FixOptions, layers: readonly CheckLayer[] = FIX_LAYERS): Promise<0 | 1> {
  const config = await planConfigFix(options, layers);
  const hooks = await planFixHooks(options.cwd, options.exec);
  const plan: ChangePlan = { writes: [...config.writes, ...hooks.writes], printed: config.printed };
  return previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: () => applyPlan(options.cwd, plan),
  });
}
