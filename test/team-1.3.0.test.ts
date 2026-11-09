import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { isRetired } from "../src/standard/retired.ts";
import { team_1_2_0 } from "../src/standard/team-1.2.0.ts";
import { team_1_3_0 } from "../src/standard/team-1.3.0.ts";
import { LANGUAGES } from "../src/standard/types.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, read, repo, upgrade } from "./standard-helpers.ts";

// team@1.3.0 as this CLI bundles it (#64): no internal mirrors and no vulnerability scans.

/** A Go project on `standard` that declares a mirror and turns the vulnerability scan on. */
const goWithMirror = (standard: string) =>
  `standard: ${standard}\ncomponents:\n  - path: ./\n    language: go\n    overrides:\n      deps.vulnScan: true\n` +
  "mirrors:\n  go: https://nexus.example.internal/repository/go-group/\n";

const declarationFindings = async (text: string) =>
  (await runCheck({ cwd: repo({ ".devguard.yaml": text }), today: TODAY, tools: noTools }, [declarationLayer]))
    .findings;

describe("team@1.3.0 drops the mirrors and the vulnerability scans (#64)", () => {
  it("has no mirrors.* or vulnerability-scan item, and keeps every other item of team@1.2.0", () => {
    expect(Object.keys(team_1_3_0.global)).toEqual(["claude.minVersion"]);
    for (const language of LANGUAGES) {
      const kept = Object.keys(team_1_2_0.languages[language]).filter((key) => !isRetired("language", key));
      expect(Object.keys(team_1_3_0.languages[language])).toEqual(kept);
    }
  });

  it("only hints at a mirrors: block or a vulnerability-scan override that is still declared", async () => {
    const findings = await declarationFindings(goWithMirror("team@1.3.0"));
    expect(rules(findings)).toEqual(["hint:declaration/retired-item", "hint:declaration/retired-item"]);
    expect(findings.map((f) => f.message)).toEqual([
      "「deps.vulnScan」沒有作用：devguard 不再檢查內部鏡像，也不再執行弱點掃描",
      "「mirrors.go」沒有作用：devguard 不再檢查內部鏡像，也不再執行弱點掃描",
    ]);
  });

  it("still reports an unknown item that was never a mirror or a scan setting", async () => {
    const text = "standard: team@1.3.0\ncomponents: []\nmirrors:\n  ftp: https://x/\n";
    expect(rules(await declarationFindings(text))).toEqual(["error:declaration/unknown-item"]);
  });

  it("standard upgrade --apply from team@1.2.0 deletes the mirror and the vulnerability-scan override", async () => {
    const dir = repo({ ".devguard.yaml": goWithMirror("team@1.2.0") });
    const preview = await upgrade(dir, { target: "team@1.3.0" });
    expect(preview.out).toContain("team@1.2.0 → team@1.3.0");
    expect(preview.out).toContain("整體｜mirrors.go（新標準已移除這個項目）");
    expect(preview.out).toContain("./ (Go)｜deps.vulnScan（新標準已移除這個項目）");
    expect((await upgrade(dir, { apply: true, target: "team@1.3.0" })).code).toBe(0);
    // The emptied overrides: and mirrors: blocks go too.
    const after = read(dir, ".devguard.yaml");
    expect(after).toBe("standard: team@1.3.0\ncomponents:\n  - path: ./\n    language: go\n");
    expect(await declarationFindings(after)).toEqual([]);
  });
});
