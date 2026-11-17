import type { Resolution } from "./declaration/resolve.ts";
import { claudeCodeLayer } from "./layers/claude-code.ts";
import { codeLayer } from "./layers/code.ts";
import { credentialsLayer } from "./layers/credentials.ts";
import { declarationLayer } from "./layers/declaration.ts";
import { depsLayer } from "./layers/deps.ts";
import { gitattributesLayer } from "./layers/gitattributes.ts";
import { pythonSettingsLayer } from "./layers/settings-python.ts";
import { goSettingsLayer } from "./layers/settings-go.ts";
import { javaSettingsLayer } from "./layers/settings-java.ts";
import { testsLayer } from "./layers/tests.ts";
import { typescriptSettingsLayer } from "./layers/settings-typescript.ts";
import { toolVersionsLayer } from "./layers/tool-versions.ts";
import { fixLayers, type CheckLayer, type CheckScope, type LayerContext, type LayerResult } from "./layers/types.ts";
import { uncoveredFilesLayer } from "./layers/uncovered.ts";
import { vscodeLayer } from "./layers/vscode.ts";
import { workingTreeCrlfLayer } from "./layers/working-tree-crlf.ts";
import type { Finding } from "./report/finding.ts";
import type { ReportInput } from "./report/render.ts";
import { listRepoFiles } from "./repo/files.ts";
import { reportingMissingTool, withoutRepeatedMissingTools } from "./tools/missing.ts";
import { createToolRunner, type ToolRunner } from "./tools/runner.ts";

export type { CheckLayer, CheckScope, LayerContext, LayerResult } from "./layers/types.ts";
export { TOOL_MISSING_RULE, toolMissingFinding } from "./tools/missing.ts";

export interface CheckResult extends ReportInput {
  resolution?: Resolution;
}

/** The layers of `devguard check`, in order. A new layer only needs to be added here (with `fixable` if `fix` repairs it). */
export const CHECK_LAYERS: readonly CheckLayer[] = [
  declarationLayer,
  uncoveredFilesLayer,
  pythonSettingsLayer,
  goSettingsLayer,
  javaSettingsLayer,
  depsLayer,
  typescriptSettingsLayer,
  toolVersionsLayer,
  gitattributesLayer,
  workingTreeCrlfLayer,
  credentialsLayer,
  claudeCodeLayer,
  vscodeLayer,
  // Layers above check the setup; code checks run last.
  codeLayer,
  // Tests and coverage run only with --full.
  testsLayer,
];

/** The layers `devguard fix` runs to find what to repair: the fixable ones of CHECK_LAYERS (`CheckLayer.fixable`). */
export const FIX_LAYERS: readonly CheckLayer[] = fixLayers(CHECK_LAYERS);

export interface CheckOptions {
  cwd: string;
  today: string;
  /** Defaults to the real runner; tests pass a fake. */
  tools?: ToolRunner;
  /** Defaults to listing the repo with git. */
  listFiles?: (cwd: string) => Promise<string[]>;
  /** Defaults to the whole repo and every category. */
  scope?: CheckScope;
  /** The staged version of a file (pre-commit hook); formatters and single-file linters check it via stdin. */
  stagedText?: (repoPath: string) => Promise<string | undefined>;
}

/** The context the layers share; `resolution` is filled in once the declaration layer has run. */
export function layerContext(options: CheckOptions): LayerContext {
  const { cwd, today } = options;
  const listFiles = options.listFiles ?? ((dir: string) => listRepoFiles(dir));
  let files: Promise<string[]> | undefined;
  return {
    cwd,
    today,
    tools: options.tools ?? createToolRunner({ cwd }),
    files: () => (files ??= listFiles(cwd)),
    scope: options.scope ?? { full: false },
    ...(options.stagedText ? { stagedText: options.stagedText } : {}),
  };
}

/**
 * Runs the layers in order and merges their findings into one report. A tool that is not installed is an error with
 * its install command, reported once, and the remaining checks still run (SPEC §11): the layers that run tools report
 * it per check (`reportingMissingTool`), and one that does not loses only its own findings to it.
 */
export async function runCheck(
  options: CheckOptions,
  layers: readonly CheckLayer[] = CHECK_LAYERS,
): Promise<CheckResult> {
  const ctx = layerContext(options);
  const findings: Finding[] = [];
  for (const layer of layers) {
    let found: LayerResult | undefined;
    findings.push(
      ...(await reportingMissingTool(async () => {
        found = await layer.run(ctx);
        return found.findings;
      })),
    );
    if (found?.resolution) ctx.resolution = found.resolution;
  }
  const { resolution } = ctx;
  return {
    standard: resolution?.standard?.id,
    components: resolution?.components ?? [],
    findings: withoutRepeatedMissingTools(findings),
    resolution,
  };
}

/** The declaration layer alone: parse `.devguard.yaml` and resolve it against the bundled standard. */
export function checkDeclaration(cwd: string, today: string): Promise<CheckResult> {
  return runCheck({ cwd, today }, [declarationLayer]);
}

/**
 * Tests and coverage alone, as `check --full` runs them (SPEC §7.1, for the pre-push hook): the declaration layer, then
 * each component's tests. Test failures and coverage below the declared threshold are separate errors.
 */
export function checkTestsAndCoverage(options: Omit<CheckOptions, "scope">): Promise<CheckResult> {
  return runCheck({ ...options, scope: { full: true } }, [declarationLayer, testsLayer]);
}

export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
