import { describe, expect, it } from "vitest";
import { legacy_1_0_0 } from "../src/standard/legacy-1.0.0.ts";
import { team_1_1_0 } from "../src/standard/team-1.1.0.ts";

// The derived standards' items, recorded before their derivation was rewritten: a refactor of how team@1.1.0 and
// legacy@1.0.0 are built from their base must not change a single item.

describe("derived standards keep their items", () => {
  it.each([team_1_1_0, legacy_1_0_0])("$id", (standard) => {
    expect({ global: standard.global, languages: standard.languages }).toMatchSnapshot();
  });
});
