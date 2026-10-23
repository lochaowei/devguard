import { describe, expect, it } from "vitest";
import { compareToDefault } from "../src/declaration/compare.ts";
import { inRange, parseRange } from "../src/versions/range.ts";

describe("version ranges", () => {
  it.each([
    [">=0.17,<0.18", "0.17.4", true],
    [">=0.17,<0.18", "0.18.0", false],
    [">=0.17,<0.18", "0.16.9", false],
    [">=2.12", "2.12.0", true],
    [">=2.12", "v2.13.1", true],
    [">2.12", "2.12", false],
    ["<=3", "3.0.0", true],
    ["==1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    [">= 1.0 , < 2.0", "1.5", true],
  ])("%s contains %s: %s", (range, version, expected) => {
    expect(inRange(version, range)).toBe(expected);
  });

  it("rejects text that is not a range", () => {
    expect(parseRange("latest")).toBeUndefined();
    expect(parseRange(">=2,<1")).toBeUndefined();
    expect(parseRange("")).toBeUndefined();
    expect(inRange("1.0", "nonsense")).toBe(false);
    expect(inRange("not-a-version", ">=1")).toBe(false);
  });

  it("judges a wider range as looser and a narrower one as stricter (SPEC §4.2)", () => {
    const item = { kind: "versionRange", label: "ruff 版本範圍", value: ">=0.17,<0.18" } as const;
    expect(compareToDefault(item, ">=0.17,<0.18")).toBe("same");
    expect(compareToDefault(item, ">=0.17.2,<0.18")).toBe("stricter");
    expect(compareToDefault(item, ">=0.17,<0.19")).toBe("looser");
    expect(compareToDefault(item, ">=0.16,<0.18")).toBe("looser");
    expect(compareToDefault(item, "==0.17.3")).toBe("stricter");
    expect(compareToDefault(item, ">=0.17")).toBe("looser");
    expect(compareToDefault(item, "latest")).toBe("invalid");
    expect(compareToDefault(item, 17)).toBe("invalid");
  });
});
