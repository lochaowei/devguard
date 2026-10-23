import { CHECK_LAYERS, runCheck, type CheckOptions, type CheckResult } from "./check.ts";
import { createEnvironmentLayer, type EnvironmentLayerOptions } from "./layers/environment.ts";

export interface DoctorOptions extends CheckOptions, EnvironmentLayerOptions {}

/**
 * `devguard doctor` (SPEC §3.2, §11): every `check` layer, then the environment layer. A tool that is not installed is
 * an environment error with its install command, so the remaining checks still run (§7.3, §7.4).
 */
export function runDoctor(options: DoctorOptions): Promise<CheckResult> {
  return runCheck({ missingTools: "report", ...options }, [...CHECK_LAYERS, createEnvironmentLayer(options)]);
}
