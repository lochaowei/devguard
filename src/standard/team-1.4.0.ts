import { deriveStandard } from "./derive.ts";
import { team_1_3_0 } from "./team-1.3.0.ts";

/**
 * team@1.4.0: team@1.3.0 with mypy 2.x in range (#113) and Bun as a TypeScript package manager (#138). Widening a
 * range or adding an alternative only loosens, so this is a minor version (SPEC §5.5).
 * - `tools.mypy` `>=1.18,<3`. Checked 2026-11-08 against PyPI's release history: the last 1.x release is 1.20.2
 *   (2026-04-21), 2.0.0 came out on 2026-05-06 and the newest is 2.4.1 (2026-10-28); 1.x has had no release since
 *   2.0. The lower bound stays, as team@1.1.0 kept the lower bounds of lines that get no more releases.
 * - TypeScript `deps.manager` also allows `bun`; its lockfile is the text `bun.lock` (Bun 1.2 and later). The default
 *   stays `npm`.
 *
 * Every item not named below is inherited from team@1.3.0 unchanged.
 */
export const team_1_4_0 = deriveStandard(team_1_3_0, {
  id: "team@1.4.0",
  set: { python: { "tools.mypy": ">=1.18,<3" } },
  allow: { typescript: { "deps.manager": ["bun"] } },
});
