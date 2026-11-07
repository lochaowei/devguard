import { deriveStandard } from "./derive.ts";
import { team_1_2_0 } from "./team-1.2.0.ts";

/** The vulnerability-scan items every language had. */
const VULN_ITEMS = ["deps.vulnScan", "deps.vulnFailOn", "deps.ignoredVulns"] as const;

/**
 * team@1.3.0: team@1.2.0 without the internal mirrors and the vulnerability scans, which devguard no longer checks or
 * runs (#64). Removing items only loosens, so this is a minor version (SPEC §5.5).
 * - Every `mirrors.*` item: where packages, tools and VS Code extensions come from is the developer's own
 *   configuration (user-level npm / uv / Poetry / Maven / Go settings), which devguard neither checks nor writes.
 * - `deps.vulnScan`, `deps.vulnFailOn`, `deps.ignoredVulns` in every language, and Go's `tools.govulncheck`.
 *
 * Every item not named below is inherited from team@1.2.0 unchanged.
 */
export const team_1_3_0 = deriveStandard(team_1_2_0, {
  id: "team@1.3.0",
  dropGlobal: Object.keys(team_1_2_0.global).filter((key) => key.startsWith("mirrors.")),
  drop: {
    python: VULN_ITEMS,
    typescript: VULN_ITEMS,
    java: VULN_ITEMS,
    go: [...VULN_ITEMS, "tools.govulncheck"],
  },
});
