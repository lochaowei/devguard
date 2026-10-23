import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/report/failure.ts";
import { checkScope } from "../src/scope.ts";

const ROOT = join(import.meta.dirname, "fixture-root");

describe("checkScope", () => {
  it("defaults to the whole repo and every category", () => {
    expect(checkScope({ files: [], full: false }, ROOT, ROOT)).toEqual({ full: false });
  });

  it("turns file arguments into repo-relative paths", () => {
    const scope = checkScope({ files: ["b.ts", join(ROOT, "web", "a.ts")], full: false }, ROOT, join(ROOT, "src"));
    expect(scope.files).toEqual(["src/b.ts", "web/a.ts"]);
  });

  it("accepts a known --only category", () => {
    expect(checkScope({ files: [], only: "format", full: false }, ROOT, ROOT)).toEqual({ only: "format", full: false });
  });

  it("rejects unknown categories, --full with files, and files outside the repo", () => {
    expect(() => checkScope({ files: [], only: "tests", full: false }, ROOT, ROOT)).toThrow(UsageError);
    expect(() => checkScope({ files: ["a.ts"], full: true }, ROOT, ROOT)).toThrow(UsageError);
    expect(() => checkScope({ files: ["../a.ts"], full: false }, ROOT, ROOT)).toThrow(/不在專案目錄中/);
    expect(() => checkScope({ files: ["."], full: false }, ROOT, ROOT)).toThrow(UsageError);
  });
});
