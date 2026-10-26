import { team_1_0_0 } from "./team-1.0.0.ts";
import type { ItemDef, ItemValue, Language, Standard } from "./types.ts";

/**
 * team@1.1.0: team@1.0.0 with these changes. Each one only loosens, so this is a minor version (SPEC §5.5).
 * - TypeScript no longer requires `eslint-plugin-sonarjs` (LGPL-3.0-only, SPEC §12 item 8, #39). With
 *   `eslint+prettier` only ESLint's built-in `complexity` is checked; Biome still checks `complexity.cognitive`
 *   through `noExcessiveCognitiveComplexity`.
 * - Widened ranges (#36). A language minimum is the oldest version its upstream still supported on 2026-10-27, and no
 *   tool range's lower bound is below the oldest line its upstream still patches. Values already at that floor stay.
 *   - `java.minVersion` 17 → 8: OpenJDK jdk8u is still maintained (Temurin 8: at least Dec 2030). Python stays 3.11
 *     (3.10 EOL 2026-10-01), Node stays 22 (20 EOL 2026-04-30), Go stays 1.26 (1.25 ended with 1.27.0).
 *   - Upper bounds widened: ruff `<1`, pyright `<2`, spotless-maven-plugin `<4`, spotless-gradle-plugin `<9`,
 *     Checkstyle `<15`, so the current releases (ruff 0.17+, spotless 3.x / 8.x, Checkstyle 14) are in range.
 *   - vitest `>=4.1`: Vitest still backports security fixes to 4.1. ESLint 9 (EOL 2026-08-06), TypeScript 5, Jest 29,
 *     Biome 1, pytest 7, pytest-cov <6 and mypy <1.18 get no more releases, so those lower bounds stay.
 *
 * Every item not listed in a language's record below is inherited from team@1.0.0 unchanged. To change one, spread
 * `withValue(language, key, value)` after the language's base items.
 */

const without = (items: Readonly<Record<string, ItemDef>>, ...keys: string[]): Record<string, ItemDef> =>
  Object.fromEntries(Object.entries(items).filter(([key]) => !keys.includes(key)));

const base = team_1_0_0;

/** A team@1.0.0 item of `language` with only its value replaced, so label, `pinnedAs` and `onPath` carry over. */
const withValue = (language: Language, key: string, value: ItemValue): Record<string, ItemDef> => {
  const item = base.languages[language][key];
  if (!item) throw new Error(`team@1.0.0 has no ${language} item ${key}`);
  return { [key]: { ...item, value } };
};

export const team_1_1_0: Standard = {
  id: "team@1.1.0",
  global: { ...base.global },
  languages: {
    python: {
      ...base.languages.python,
      ...withValue("python", "tools.ruff", ">=0.17,<1"),
      ...withValue("python", "tools.pyright", ">=1.1.400,<2"),
    },
    go: { ...base.languages.go },
    typescript: {
      ...without(base.languages.typescript, "tools.eslint-plugin-sonarjs"),
      ...withValue("typescript", "tools.vitest", ">=4.1,<6"),
    },
    java: {
      ...base.languages.java,
      ...withValue("java", "java.minVersion", "8"),
      ...withValue("java", "tools.spotless-maven-plugin", ">=2.44,<4"),
      ...withValue("java", "tools.spotless-gradle-plugin", ">=7,<9"),
      ...withValue("java", "tools.checkstyle", ">=10.21,<15"),
    },
  },
};
