import type { LayerContext } from "../layers/types.ts";
import type { EnvVars, Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";

/** What an environment check can see: the check context plus the machine (processes, environment variables). */
export interface EnvironmentContext extends LayerContext {
  /** Runs git, `code`, `claude`...; tests pass a fake. */
  exec: Exec;
  /** The process environment (mirror credentials, SPEC §10.3); tests pass their own. */
  env: EnvVars;
}

/**
 * One check only `devguard doctor` runs (SPEC §3.2): whether the setup actually takes effect on this machine.
 * Findings about the machine use layer "environment" (the standard-upgrade hint stays "config"). Report only problems,
 * each with the `devguard install` (or other) command that fixes it; doctor never installs anything itself.
 */
export interface EnvironmentCheck {
  id: string;
  run(ctx: EnvironmentContext): Promise<Finding[]>;
}
