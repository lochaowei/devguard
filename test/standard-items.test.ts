import { describe, expect, it } from "vitest";
import { deriveStandard } from "../src/standard/derive.ts";
import { legacy_1_0_0 } from "../src/standard/legacy-1.0.0.ts";
import { team_1_1_0 } from "../src/standard/team-1.1.0.ts";

// The derived standards' items, recorded before their derivation was rewritten: a refactor of how team@1.1.0 and
// legacy@1.0.0 are built from their base must not change a single item.

describe("derived standards keep their items", () => {
  it.each([team_1_1_0, legacy_1_0_0])("$id", (standard) => {
    expect({ global: standard.global, languages: standard.languages }).toMatchSnapshot();
  });
});

describe("deriveStandard names only items the base has", () => {
  it("throws on a set or dropped item the base's language does not have", () => {
    expect(() => deriveStandard(team_1_1_0, { id: "x@1.0.0", set: { go: { "tools.ruff": ">=1" } } })).toThrow(
      "team@1.1.0 has no go item tools.ruff",
    );
    expect(() =>
      deriveStandard(team_1_1_0, { id: "x@1.0.0", drop: { typescript: ["tools.eslint-plugin-sonarjs"] } }),
    ).toThrow("team@1.1.0 has no typescript item tools.eslint-plugin-sonarjs");
  });

  it("throws on an every-language item a language lacks unless it is optional there", () => {
    const everyLanguage = { "complexity.cognitive": 30 };
    expect(() => deriveStandard(team_1_1_0, { id: "x@1.0.0", everyLanguage })).toThrow(
      "team@1.1.0 has no python item complexity.cognitive",
    );
    const derived = deriveStandard(team_1_1_0, {
      id: "x@1.0.0",
      everyLanguage,
      optional: { python: ["complexity.cognitive"] },
    });
    expect(derived.languages.go["complexity.cognitive"]?.value).toBe(30);
    expect(derived.languages.python["complexity.cognitive"]).toBeUndefined();
  });
});
