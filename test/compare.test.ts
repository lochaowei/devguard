import { describe, expect, it } from "vitest";
import { compareToDefault } from "../src/declaration/compare.ts";
import type { ItemDef } from "../src/standard/types.ts";

const item = (kind: ItemDef["kind"], value: ItemDef["value"], allowed?: string[]): ItemDef => ({
  kind,
  label: "x",
  value,
  allowed,
});

describe("compareToDefault", () => {
  it.each([
    ["max", 10, 8, "stricter"],
    ["max", 10, 10, "same"],
    ["max", 10, 15, "looser"],
    ["min", 80, 90, "stricter"],
    ["min", 80, 60, "looser"],
    ["max", 10, "10", "invalid"],
  ] as const)("%s default %s, value %s → %s", (kind, def, value, expected) => {
    expect(compareToDefault(item(kind, def), value)).toBe(expected);
  });

  it("compares dotted versions numerically", () => {
    const v = item("minVersion", "3.11");
    expect(compareToDefault(v, "3.12")).toBe("stricter");
    expect(compareToDefault(v, "3.9")).toBe("looser");
    expect(compareToDefault(v, "3.11.0")).toBe("same");
    expect(compareToDefault(v, "3.x")).toBe("invalid");
  });

  it("treats true as stricter for booleans", () => {
    expect(compareToDefault(item("bool", false), true)).toBe("stricter");
    expect(compareToDefault(item("bool", true), false)).toBe("looser");
    expect(compareToDefault(item("bool", true), "yes")).toBe("invalid");
  });

  it("treats a lower severity as stricter", () => {
    const s = item("severity", "high");
    expect(compareToDefault(s, "low")).toBe("stricter");
    expect(compareToDefault(s, "critical")).toBe("looser");
    expect(compareToDefault(s, "severe")).toBe("invalid");
  });

  it("treats removing list entries as looser and adding as stricter", () => {
    const l = item("list", ["moment", "request"]);
    expect(compareToDefault(l, ["request"])).toBe("looser");
    expect(compareToDefault(l, ["request", "moment"])).toBe("same");
    expect(compareToDefault(l, ["moment", "request", "lodash"])).toBe("stricter");
    expect(compareToDefault(l, "moment")).toBe("invalid");
  });

  it("separates allowed alternatives from unlisted tools", () => {
    const c = item("choice", "eslint+prettier", ["eslint+prettier", "biome"]);
    expect(compareToDefault(c, "biome")).toBe("alternative");
    expect(compareToDefault(c, "rome")).toBe("looser");
    expect(compareToDefault(c, 3)).toBe("invalid");
  });

  it("never judges style items as looser", () => {
    expect(compareToDefault(item("style", 120), 100)).toBe("different");
    expect(compareToDefault(item("style", 120), 120)).toBe("same");
    expect(compareToDefault(item("style", ["gofumpt"]), ["gofmt"])).toBe("different");
    expect(compareToDefault(item("style", 120), "wide")).toBe("invalid");
  });

  it("treats any ignored vulnerability as looser", () => {
    const v = item("ignoredVulns", []);
    expect(compareToDefault(v, [])).toBe("same");
    expect(compareToDefault(v, [{ id: "GHSA-1" }])).toBe("looser");
    expect(compareToDefault(v, "GHSA-1")).toBe("invalid");
  });
});
