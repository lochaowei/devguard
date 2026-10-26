import { team_1_0_0 } from "./team-1.0.0.ts";
import type { ItemDef, Standard } from "./types.ts";

/**
 * team@1.1.0: team@1.0.0 with these changes. Each one only loosens, so this is a minor version (SPEC §5.5).
 * - TypeScript no longer requires `eslint-plugin-sonarjs` (LGPL-3.0-only, SPEC §12 item 8, #39). With
 *   `eslint+prettier` only ESLint's built-in `complexity` is checked; Biome still checks `complexity.cognitive`
 *   through `noExcessiveCognitiveComplexity`.
 *
 * Every item not listed in a language's record below is inherited from team@1.0.0 unchanged.
 */

const without = (items: Readonly<Record<string, ItemDef>>, ...keys: string[]): Record<string, ItemDef> =>
  Object.fromEntries(Object.entries(items).filter(([key]) => !keys.includes(key)));

const base = team_1_0_0;

export const team_1_1_0: Standard = {
  id: "team@1.1.0",
  global: { ...base.global },
  languages: {
    python: { ...base.languages.python },
    go: { ...base.languages.go },
    typescript: { ...without(base.languages.typescript, "tools.eslint-plugin-sonarjs") },
    java: { ...base.languages.java },
  },
};
