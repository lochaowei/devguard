import { deriveStandard } from "./derive.ts";
import { team_1_0_0 } from "./team-1.0.0.ts";

/**
 * team@1.1.0: team@1.0.0 with these changes. Each one only loosens, so this is a minor version (SPEC §5.5).
 * - TypeScript no longer requires `eslint-plugin-sonarjs` (LGPL-3.0-only, SPEC §12 item 8, #39). With
 *   `eslint+prettier` only ESLint's built-in `complexity` is checked; Biome still checks `complexity.cognitive`
 *   through `noExcessiveCognitiveComplexity`.
 * - Tool ranges reviewed in #36 (2026-10-27): they are decided, not placeholders. No lower bound is below the oldest
 *   line its upstream still patches; ranges already right are inherited from team@1.0.0 as they are.
 *   - Language minimums stay: Python 3.11 (3.10 EOL 2026-10-01), Node 22 (20 EOL 2026-04-30), Go 1.26 (1.25 ended
 *     with 1.27.0), and Java 17, the minimum of the mainstream frameworks (Spring Boot 3) for new projects (maintainer
 *     decision on #36). Java 8 projects use legacy@1.0.0.
 *   - Upper bounds widened: ruff `<1`, pyright `<2`, spotless-maven-plugin `<4`, spotless-gradle-plugin `<9`,
 *     Checkstyle `<15`, so the current releases (ruff 0.17+, spotless 3.x / 8.x, Checkstyle 14) are in range.
 *   - vitest `>=4.1`: Vitest still backports security fixes to 4.1. ESLint 9 (EOL 2026-08-06), TypeScript 5, Jest 29,
 *     Biome 1, pytest 7, pytest-cov <6 and mypy <1.18 get no more releases, so those lower bounds stay.
 *
 * Every item not named below is inherited from team@1.0.0 unchanged.
 */
export const team_1_1_0 = deriveStandard(team_1_0_0, {
  id: "team@1.1.0",
  set: {
    python: { "tools.ruff": ">=0.17,<1", "tools.pyright": ">=1.1.400,<2" },
    typescript: { "tools.vitest": ">=4.1,<6" },
    java: {
      "tools.spotless-maven-plugin": ">=2.44,<4",
      "tools.spotless-gradle-plugin": ">=7,<9",
      "tools.checkstyle": ">=10.21,<15",
    },
  },
  drop: { typescript: ["tools.eslint-plugin-sonarjs"] },
});
