import { checkTestsAndCoverage } from "../check.ts";
import type { EnvVars } from "../process/exec.ts";
import { exitCodeFor, renderText } from "../report/render.ts";
import type { HookContext } from "./pre-commit.ts";

/** The environment variable that opts a developer's pushes into the full tests (SPEC §7.1, §7.4). */
export const PRE_PUSH_ENV = "DEVGUARD_PRE_PUSH";

/** Whether the pre-push hook runs the full tests: only when `DEVGUARD_PRE_PUSH=full`; any other value leaves it off. */
export function prePushRunsTests(env: EnvVars): boolean {
  return env[PRE_PUSH_ENV] === "full";
}

/**
 * `devguard hook git-pre-push` (SPEC §7.1, §7.4). By default it lets every push through at once: the full tests,
 * coverage and vulnerability scans belong to `devguard check --full` (CI). With `DEVGUARD_PRE_PUSH=full` it runs them
 * as `check --full` does, whatever is being pushed: prints nothing when they pass; otherwise prints the findings and
 * returns non-zero, which blocks the push. Git's arguments (remote name, URL) and the refs on stdin are not needed.
 */
export async function runPrePush(ctx: HookContext): Promise<number> {
  if (!prePushRunsTests(ctx.env ?? process.env)) return 0;
  const result = await checkTestsAndCoverage({ ...ctx, missingTools: "report" });
  const code = exitCodeFor(result.findings, false);
  if (code !== 0) ctx.write(renderText(result));
  return code;
}
