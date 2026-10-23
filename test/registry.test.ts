import { describe, expect, it } from "vitest";
import { findStandard } from "../src/standard/registry.ts";
import { team_1_0_0 } from "../src/standard/team-1.0.0.ts";

const bundled = [team_1_0_0, { ...team_1_0_0, id: "team@1.2.0" }];

describe("findStandard", () => {
  it("finds an exact bundled version", () => {
    const r = findStandard("team@1.2.0", bundled);
    expect(r.ok && r.standard.id).toBe("team@1.2.0");
  });

  it.each([
    ["team@1", "malformed"],
    ["team@^1.0.0", "malformed"],
    ["other@1.0.0", "unknown-name"],
    ["team@1.3.0", "newer-than-cli"],
    ["team@2.0.0", "newer-than-cli"],
    ["team@1.1.0", "no-longer-bundled"],
    ["team@0.9.0", "no-longer-bundled"],
  ])("%s → %s", (id, reason) => {
    expect(findStandard(id, bundled)).toEqual({ ok: false, reason });
  });
});
