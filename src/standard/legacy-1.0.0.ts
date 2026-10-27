import { team_1_1_0 } from "./team-1.1.0.ts";
import type { ItemDef, ItemValue, Language, Standard } from "./types.ts";

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

const base = team_1_1_0;

/** A team@1.1.0 item of `language` with only its value replaced, so label and kind carry over. */
const withValue = (language: Language, key: string, value: ItemValue): Record<string, ItemDef> => {
  const item = base.languages[language][key];
  if (!item) throw new Error(`team@1.1.0 has no ${language} item ${key}`);
  return { [key]: { ...item, value } };
};

/** The items every language loosens the same way; a language without one of them (Python cognitive) skips it. */
const common = (language: Language): Record<string, ItemDef> =>
  Object.fromEntries(
    Object.entries({ "coverage.lines": 0, "complexity.cyclomatic": 20, "complexity.cognitive": 25 })
      .filter(([key]) => key in base.languages[language])
      .flatMap(([key, value]) => Object.entries(withValue(language, key, value))),
  );

export const legacy_1_0_0: Standard = {
  id: "legacy@1.0.0",
  upgradesTo: "team@1.1.0",
  global: { ...base.global },
  languages: {
    python: {
      ...base.languages.python,
      ...common("python"),
      ...withValue("python", "typecheck.strict", false),
      ...withValue("python", "deps.banned", ["pycrypto"]),
    },
    go: {
      ...base.languages.go,
      ...common("go"),
      ...withValue("go", "deps.banned", []),
    },
    typescript: {
      ...base.languages.typescript,
      ...common("typescript"),
      ...withValue("typescript", "typecheck.strict", false),
      ...withValue("typescript", "typecheck.options", []),
      ...withValue("typescript", "deps.banned", ["request"]),
    },
    java: {
      ...base.languages.java,
      ...common("java"),
      ...withValue("java", "java.minVersion", "8"),
      ...withValue("java", "deps.banned", ["log4j:log4j"]),
    },
  },
};
