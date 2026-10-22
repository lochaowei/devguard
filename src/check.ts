import type { Resolution } from "./declaration/resolve.ts";
import { codeLayer } from "./layers/code.ts";
import { declarationLayer } from "./layers/declaration.ts";
import type { CheckLayer, CheckScope, LayerContext } from "./layers/types.ts";
import { uncoveredFilesLayer } from "./layers/uncovered.ts";
import type { Finding } from "./report/finding.ts";
import type { ReportInput } from "./report/render.ts";
import { listRepoFiles } from "./repo/files.ts";
import { createToolRunner, type ToolRunner } from "./tools/runner.ts";

export type { CheckLayer, CheckScope, LayerContext, LayerResult } from "./layers/types.ts";

export interface CheckResult extends ReportInput {
  resolution?: Resolution;
}

/** The layers of `devguard check`, in order. A new layer only needs to be added here. */
export const CHECK_LAYERS: readonly CheckLayer[] = [
  declarationLayer,
  uncoveredFilesLayer,
  // Layers above check the setup; code checks run last.
  codeLayer,
];

export interface CheckOptions {
  cwd: string;
  today: string;
  /** Defaults to the real runner; tests pass a fake. */
  tools?: ToolRunner;
  /** Defaults to listing the repo with git. */
  listFiles?: (cwd: string) => Promise<string[]>;
  /** Defaults to the whole repo and every category. */
  scope?: CheckScope;
}

function layerContext(options: CheckOptions): LayerContext {
  const { cwd, today } = options;
  const listFiles = options.listFiles ?? ((dir: string) => listRepoFiles(dir));
  let files: Promise<string[]> | undefined;
  return {
    cwd,
    today,
    tools: options.tools ?? createToolRunner({ cwd }),
    files: () => (files ??= listFiles(cwd)),
    scope: options.scope ?? { full: false },
  };
}

/** Runs the layers in order and merges their findings into one report. */
export async function runCheck(
  options: CheckOptions,
  layers: readonly CheckLayer[] = CHECK_LAYERS,
): Promise<CheckResult> {
  const ctx = layerContext(options);
  const findings: Finding[] = [];
  for (const layer of layers) {
    const result = await layer.run(ctx);
    findings.push(...result.findings);
    if (result.resolution) ctx.resolution = result.resolution;
  }
  const { resolution } = ctx;
  return { standard: resolution?.standard?.id, components: resolution?.components ?? [], findings, resolution };
}

/** The declaration layer alone: parse `.devguard.yaml` and resolve it against the bundled standard. */
export function checkDeclaration(cwd: string, today: string): Promise<CheckResult> {
  return runCheck({ cwd, today }, [declarationLayer]);
}

export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
