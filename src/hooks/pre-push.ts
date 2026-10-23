import { checkTestsAndCoverage } from "../check.ts";
import { exitCodeFor, renderText } from "../report/render.ts";
import type { HookContext } from "./pre-commit.ts";

/**
 * `devguard hook git-pre-push` (SPEC §7.1, §7.4): run every component's tests in full and check coverage against the
 * standard, whatever is being pushed. Prints nothing when it passes; otherwise prints the findings and returns
 * non-zero, which blocks the push. Git's arguments (remote name, URL) and the refs on stdin are not needed.
 */
export async function runPrePush(ctx: HookContext): Promise<number> {
  const result = await checkTestsAndCoverage({ ...ctx, missingTools: "report" });
  const code = exitCodeFor(result.findings, false);
  if (code !== 0) ctx.write(renderText(result));
  return code;
}
