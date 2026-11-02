import { deriveStandard } from "./derive.ts";
import { team_1_1_0 } from "./team-1.1.0.ts";

/**
 * team@1.2.0: team@1.1.0 with basedpyright as another allowed Python type checker (#68). A new alternative only
 * loosens, so this is a minor version (SPEC §5.5).
 * - `typecheck.tool` also allows `basedpyright`, which devguard runs as `basedpyright --outputjson` (the same output as
 *   pyright) and whose strict mode it reads from `[tool.basedpyright]` or `pyrightconfig.json`.
 * - `tools.basedpyright` `>=1.40,<2`, chosen as team@1.1.0 chose its ranges: the lower bound is the oldest line upstream
 *   still patches, the upper bound the next major. Checked 2026-11-03 against PyPI's release history and the GitHub
 *   releases of DetachHead/basedpyright: every release is cut from `main` in sequence (1.39.10 on 2026-08-13 was the
 *   last 1.39 release, before 1.40.0 on 2026-09-07; the newest is 1.40.2 of 2026-10-04), and the repo's SECURITY.md
 *   names no supported older lines, so only the current line, 1.40, is maintained.
 *
 * Every item not named below is inherited from team@1.1.0 unchanged.
 */
export const team_1_2_0 = deriveStandard(team_1_1_0, {
  id: "team@1.2.0",
  allow: { python: { "typecheck.tool": ["basedpyright"] } },
  add: {
    python: {
      "tools.basedpyright": {
        kind: "versionRange",
        label: "basedpyright 版本範圍",
        value: ">=1.40,<2",
        pinnedAs: ["basedpyright"],
      },
    },
  },
});
