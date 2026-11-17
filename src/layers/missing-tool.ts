import type { Finding } from "../report/finding.ts";
import { ToolMissingError } from "../tools/runner.ts";

export const TOOL_MISSING_RULE = "environment/tool-missing";

/** The tool-missing findings that are only a Java build wrapper that is not there; `settings/wrapper-missing` says it. */
const wrapperFindings = new WeakSet<Finding>();

/** A tool that is not installed, as doctor and the hooks report it (SPEC §5.2: the install command, never a download). */
export function toolMissingFinding(e: ToolMissingError, component?: string): Finding {
  const finding: Finding = {
    level: "error",
    layer: "environment",
    rule: TOOL_MISSING_RULE,
    message: e.message,
    ...(component === undefined ? {} : { component }),
    fix: e.install,
  };
  if (e.javaWrapper) wrapperFindings.add(finding);
  return finding;
}

/** Runs `run`; a tool that is not installed becomes one finding (of `component`) instead of aborting the caller. */
export async function orMissingTool(run: () => Promise<Finding[]>, component?: string): Promise<Finding[]> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ToolMissingError)) throw e;
    return [toolMissingFinding(e, component)];
  }
}

/** The same tool missing, with the same install command, reported by another layer or component is reported once. */
export const repeated = (f: Finding, seen: readonly Finding[]) =>
  f.rule === TOOL_MISSING_RULE && seen.some((g) => g.rule === f.rule && g.message === f.message && g.fix === f.fix);

/**
 * A missing Java wrapper that `settings/wrapper-missing` reports for the same component is not reported again as a
 * missing tool: the two would say the same thing with different fix commands (#217). Another component's missing
 * wrapper stays, and so does one without the settings finding (e.g. `--only lint`).
 */
export function withoutDuplicateWrapper(findings: Finding[]): Finding[] {
  const reported = new Set(findings.filter((f) => f.rule === "settings/wrapper-missing").map((f) => f.component));
  return findings.filter((f) => !(wrapperFindings.has(f) && reported.has(f.component)));
}
