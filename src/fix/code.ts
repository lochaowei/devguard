import { layerContext, type CheckOptions } from "../check.ts";
import { fileBatches, toolFailed } from "../code/support.ts";
import type { CodeCheckContext, FixStep } from "../code/types.ts";
import { checkTargets, codeCheckContext, codeTargets, type PlannedTarget } from "../layers/code.ts";
import { declarationLayer } from "../layers/declaration.ts";
import type { Finding } from "../report/finding.ts";
import { exitCodeFor, renderText } from "../report/render.ts";
import { previewThenApply, type Interaction } from "./interaction.ts";

export interface CodeFixOptions extends CheckOptions {
  io: Interaction;
}

interface TargetFix {
  planned: PlannedTarget;
  steps: FixStep[];
  fixable: Finding[];
}

const where = (f: Finding) => `${f.file ?? ""}${f.line === undefined ? "" : `:${String(f.line)}`}`;

const command = (step: FixStep, files: readonly string[] | undefined) =>
  [
    step.tool,
    ...step.args,
    ...(files === undefined ? [] : files.length > 3 ? [`…（${String(files.length)} 個檔案）`] : files),
  ].join(" ");

function renderPreview(fixes: readonly TargetFix[]): string {
  if (fixes.length === 0) return "沒有可自動修正的程式碼問題。\n";
  const out = ["將自動修正以下程式碼問題："];
  for (const { planned, steps, fixable } of fixes) {
    const { target } = planned;
    out.push(
      "",
      `${target.component ?? `（未涵蓋的 ${target.language} 檔案）`}  在 ${target.dir || "repo 根目錄"} 執行：`,
    );
    out.push(...steps.map((s) => `  ${command(s, s.files)}`));
    out.push(...fixable.map((f) => `  - ${where(f)}  ${f.message}  [${f.rule}]`));
  }
  return out.join("\n") + "\n\n";
}

/** Runs the steps in order; a run that fails is reported as a finding and the remaining steps still run. */
async function runSteps(fix: TargetFix, ctx: CodeCheckContext): Promise<Finding[]> {
  const { target } = fix.planned;
  const failures: Finding[] = [];
  for (const step of fix.steps) {
    const batches = step.files === undefined ? [[]] : fileBatches(step.files);
    for (const batch of batches) {
      const request = { language: target.language, tool: step.tool, dir: target.dir, args: [...step.args, ...batch] };
      const result = await ctx.tools.run(step.env ? { ...request, env: step.env } : request);
      if (result.code > step.okUpTo) failures.push(toolFailed(target, step.tool, result));
    }
  }
  return failures;
}

/**
 * `devguard fix --code [files]` (SPEC §9.1): checks the code, previews the formatter and lint-fix runs that resolve the
 * fixable findings, applies them under the shared interaction rules (SPEC §9.3), then checks again and reports what
 * is left. Returns the exit code: 1 when nothing was applied though something could be, or when errors remain.
 */
export async function runCodeFix(options: CodeFixOptions): Promise<0 | 1> {
  const ctx = layerContext(options);
  ctx.resolution = (await declarationLayer.run(ctx)).resolution;
  const targets = await codeTargets(ctx);
  const checkCtx = codeCheckContext(ctx);
  const before = await checkTargets(targets, checkCtx);
  const fixes: TargetFix[] = [];
  for (const planned of targets) {
    const owned = new Set(planned.owned);
    const fixable = before.filter((f) => f.fixable === true && f.file !== undefined && owned.has(f.file));
    if (fixable.length > 0)
      fixes.push({ planned, fixable, steps: await planned.checker.fixSteps(planned.target, checkCtx) });
  }
  const failures: Finding[] = [];
  const pending = fixes.length > 0;
  const code = await previewThenApply(options.io, {
    preview: renderPreview(fixes),
    pending,
    async apply() {
      for (const fix of fixes) failures.push(...(await runSteps(fix, checkCtx)));
    },
  });
  if (code !== 0) return code;
  // Exit 0 with something pending means it was applied: check again. Otherwise the first check still holds.
  const left = [...failures, ...(pending ? await checkTargets(targets, checkCtx) : before)];
  const heading = pending ? "修正後再次檢查，剩餘的程式碼問題：" : "剩餘的程式碼問題：";
  options.io.write(`\n${heading}\n${renderText({ components: [], findings: left })}`);
  return exitCodeFor(left, false);
}
