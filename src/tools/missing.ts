import type { Finding } from "../report/finding.ts";
import { ToolMissingError } from "./runner.ts";

export const TOOL_MISSING_RULE = "environment/tool-missing";

/** A tool that is not installed, as every check reports it (SPEC §5.2, §11: the install command, never a download). */
export function toolMissingFinding(e: ToolMissingError): Finding {
  return { level: "error", layer: "environment", rule: TOOL_MISSING_RULE, message: e.message, fix: e.install };
}

/**
 * Runs one check that needs a project tool. A tool that is not installed becomes that check's finding instead of
 * ending the whole run, so the checks that need other tools still report (SPEC §11, #217). Wrap the smallest unit
 * that shares a tool: what `run` found before the tool turned out to be missing is not kept.
 */
export async function reportingMissingTool(run: () => Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ToolMissingError)) throw e;
    return [toolMissingFinding(e)];
  }
}

/**
 * The findings less the missing tools already said: the same tool met by another check or component, and a tool whose
 * install command another rule already gave (a Java build wrapper that is not committed, `settings/wrapper-missing`).
 */
export function withoutRepeatedMissingTools(findings: readonly Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const repeated =
      f.rule === TOOL_MISSING_RULE &&
      kept.some((g) => (g.rule === f.rule ? g.message === f.message : g.fix !== undefined && g.fix === f.fix));
    if (!repeated) kept.push(f);
  }
  return kept;
}
