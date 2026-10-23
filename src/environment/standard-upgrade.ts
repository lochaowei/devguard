import { BUNDLED_STANDARDS } from "../standard/registry.ts";
import type { Standard } from "../standard/types.ts";
import { upgradeSuggestion } from "../standard/upgrade.ts";
import type { EnvironmentCheck } from "./types.ts";

/**
 * Whether the installed CLI bundles a minor or patch update of the declared standard: doctor suggests it, check does
 * not (SPEC §5.5). Reads the resolution the declaration layer left.
 */
export function createStandardUpgradeCheck(bundled: readonly Standard[] = BUNDLED_STANDARDS): EnvironmentCheck {
  return {
    id: "standard-upgrade",
    run({ resolution }) {
      const suggestion = resolution?.standard ? upgradeSuggestion(resolution.standard.id, bundled) : undefined;
      return Promise.resolve(suggestion ? [suggestion] : []);
    },
  };
}
