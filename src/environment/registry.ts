import { gitHooksCheck } from "./git-hooks.ts";
import { goMirrorsCheck } from "./go-mirrors.ts";
import { mirrorCredentialsCheck } from "./mirror-credentials.ts";
import { createStandardUpgradeCheck } from "./standard-upgrade.ts";
import type { EnvironmentCheck } from "./types.ts";

export type { EnvironmentCheck, EnvironmentContext } from "./types.ts";

/**
 * The checks only `devguard doctor` runs, in order (SPEC §3.2). A new one (VS Code extensions, Claude Code, mirrors
 * and credentials) only needs a module of its own in `src/environment/` and one line here.
 */
export const ENVIRONMENT_CHECKS: readonly EnvironmentCheck[] = [
  createStandardUpgradeCheck(),
  gitHooksCheck,
  goMirrorsCheck,
  mirrorCredentialsCheck,
];
