import { deriveStandard } from "./derive.ts";
import { team_1_1_0 } from "./team-1.1.0.ts";

/**
 * legacy@1.0.0: a baseline for existing (brownfield) projects, so they can be brought under devguard without a pile
 * of `reason` / `until` deviations, then moved to team@1.1.0 with `devguard standard upgrade` (#37). It starts from
 * team@1.1.0 and loosens only what most often blocks an existing project:
 * - `coverage.lines` 0: tests still run, but no coverage total fails and no tool config needs a threshold.
 * - `typecheck.strict` false (TypeScript, Python); TypeScript `typecheck.options` [].
 * - `complexity.cyclomatic` 20, `complexity.cognitive` 25.
 * - `deps.banned` keeps only packages with known, unfixed vulnerabilities: Python `pycrypto`, TypeScript `request`,
 *   Java `log4j:log4j` (1.x). JUnit 4 (`junit:junit`), `nose`, `moment`, `node-fetch` and the Go modules are allowed.
 * - `java.minVersion` 8 (team@1.1.0 keeps 17), so Java 8 projects can be admitted.
 *
 * Every other item is team@1.1.0's, so upgrading only tightens these. legacy is never the default: `draft` writes
 * team, and team never upgrades to legacy.
 */
export const legacy_1_0_0 = deriveStandard(team_1_1_0, {
  id: "legacy@1.0.0",
  upgradesTo: "team@1.1.0",
  everyLanguage: { "coverage.lines": 0, "complexity.cyclomatic": 20, "complexity.cognitive": 25 },
  optional: { python: ["complexity.cognitive"] },
  set: {
    python: { "typecheck.strict": false, "deps.banned": ["pycrypto"] },
    go: { "deps.banned": [] },
    typescript: { "typecheck.strict": false, "typecheck.options": [], "deps.banned": ["request"] },
    java: { "java.minVersion": "8", "deps.banned": ["log4j:log4j"] },
  },
});
