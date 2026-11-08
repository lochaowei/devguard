import { FIX_LAYERS, runCheck, type CheckLayer, type CheckOptions } from "../check.ts";
import type { Resolution } from "../declaration/resolve.ts";
import { planFixHooks } from "../hooks/install.ts";
import { GITATTRIBUTES, hasEolRule } from "../layers/gitattributes.ts";
import type { Exec } from "../process/exec.ts";
import { crlfWorkingTreeFiles, RECHECKOUT_HINT } from "../repo/eol.ts";
import { renderText } from "../report/render.ts";
import { previewThenApply, type Interaction } from "./interaction.ts";
import { applyPlan, planChanges, renderPlan, type ChangePlan } from "./plan.ts";

export interface FixOptions extends CheckOptions {
  io: Interaction;
  /** Runs git (where the hooks live); defaults to the real one. */
  exec?: Exec;
}

export interface ConfigFix extends ChangePlan {
  /** The report of the declaration errors when there is no usable declaration to fix against. */
  blocked?: string;
  /** The declaration the plan was made against. */
  resolution?: Resolution;
}

/** Runs the config checks and plans the repairs their findings carry, by file category. Writes nothing. */
export async function planConfigFix(
  options: CheckOptions,
  layers: readonly CheckLayer[] = FIX_LAYERS,
): Promise<ConfigFix> {
  const result = await runCheck(options, layers);
  // No standard resolved (no or invalid .devguard.yaml): the declaration errors are the answer, not "nothing to fix".
  if (!result.resolution?.standard && result.findings.some((f) => f.level === "error")) {
    return { writes: [], printed: [], blocked: renderText(result, false) };
  }
  const plan = await planChanges(
    options.cwd,
    result.findings.flatMap((f) => f.repairs ?? []),
  );
  return { ...plan, ...(result.resolution ? { resolution: result.resolution } : {}) };
}

/**
 * `devguard fix` (SPEC §9): runs the config checks, plans the repairs their findings carry by file category, adds
 * devguard's own git hooks that were modified, then previews and applies them under the shared interaction rules.
 * Returns the exit code.
 */
export async function runFix(options: FixOptions, layers: readonly CheckLayer[] = FIX_LAYERS): Promise<0 | 1> {
  const config = await planConfigFix(options, layers);
  if (config.blocked !== undefined) {
    options.io.write(config.blocked);
    return 1;
  }
  const hooks = await planFixHooks(options.cwd, options.exec);
  const plan: ChangePlan = { writes: [...config.writes, ...hooks.writes], printed: config.printed };
  const state = { applied: false };
  const code = await previewThenApply(options.io, {
    preview: renderPlan(plan),
    pending: plan.writes.length > 0,
    apply: async () => {
      await applyPlan(options.cwd, plan);
      state.applied = true;
    },
  });
  if (state.applied && addsEolRule(plan) && (await crlfWorkingTreeFiles(options.cwd, options.exec)).length > 0) {
    options.io.write(`\n${GITATTRIBUTES} 的換行規則只影響之後 checkout 的檔案，工作目錄裡已經是 CRLF 的檔案不會變。\n`);
    options.io.write(`${RECHECKOUT_HINT}\n`);
  }
  return code;
}

/**
 * Whether the plan adds the LF rule to `.gitattributes`. Files already checked out keep their CRLF line endings, so
 * `fix` then tells how to check out again (#84); it never does so itself, nor touches the index.
 */
function addsEolRule(plan: ChangePlan): boolean {
  return plan.writes.some((w) => w.file === GITATTRIBUTES && !hasEolRule(w.before) && hasEolRule(w.after));
}
