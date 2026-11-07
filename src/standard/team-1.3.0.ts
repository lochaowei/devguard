import { deriveStandard } from "./derive.ts";
import { RETIRED_ITEMS } from "./retired.ts";
import { team_1_2_0 } from "./team-1.2.0.ts";
import { LANGUAGES } from "./types.ts";

/**
 * team@1.3.0: team@1.2.0 without the internal mirrors and the vulnerability scans, which devguard no longer checks or
 * runs (#64, `RETIRED_ITEMS`). Removing items only loosens, so this is a minor version (SPEC §5.5).
 * - Every `mirrors.*` item: where packages, tools and VS Code extensions come from is the developer's own
 *   configuration (user-level npm / uv / Poetry / Maven / Go settings), which devguard neither checks nor writes.
 * - `deps.vulnScan`, `deps.vulnFailOn`, `deps.ignoredVulns` in every language, and Go's `tools.govulncheck`.
 *
 * Every item not named below is inherited from team@1.2.0 unchanged.
 */
export const team_1_3_0 = deriveStandard(team_1_2_0, {
  id: "team@1.3.0",
  dropGlobal: RETIRED_ITEMS.global,
  drop: Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      RETIRED_ITEMS.language.filter((key) => Object.hasOwn(team_1_2_0.languages[language], key)),
    ]),
  ),
});
