import { ENVIRONMENT_CHECKS, type EnvironmentCheck } from "../environment/registry.ts";
import { nodeExec, type EnvVars, type Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import type { CheckLayer } from "./types.ts";

export interface EnvironmentLayerOptions {
  checks?: readonly EnvironmentCheck[];
  exec?: Exec;
  env?: EnvVars;
}

/** The environment layer: only `doctor` runs it, never `check` (SPEC §3.2). */
export function createEnvironmentLayer(options: EnvironmentLayerOptions = {}): CheckLayer {
  const checks = options.checks ?? ENVIRONMENT_CHECKS;
  const exec = options.exec ?? nodeExec;
  const env = options.env ?? process.env;
  return {
    id: "environment",
    async run(ctx) {
      const findings: Finding[] = [];
      for (const check of checks) findings.push(...(await check.run({ ...ctx, exec, env })));
      return { findings };
    },
  };
}
