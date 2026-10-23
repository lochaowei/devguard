import { CHECK_LAYERS, runCheck, type CheckOptions, type CheckResult } from "./check.ts";
import { createEnvironmentLayer, type EnvironmentLayerOptions } from "./layers/environment.ts";

export interface DoctorOptions extends CheckOptions, EnvironmentLayerOptions {}

/** `devguard doctor` (SPEC §3.2, §11): every `check` layer, then the environment layer. */
export function runDoctor(options: DoctorOptions): Promise<CheckResult> {
  return runCheck(options, [...CHECK_LAYERS, createEnvironmentLayer(options)]);
}
