import { describe, expect, it } from "vitest";
import { findOwner } from "../src/declaration/lookup.ts";
import { normalizeDir, normalizePath } from "../src/declaration/path.ts";
import { resolveText } from "./helpers.ts";

const monorepo = resolveText(
  [
    "standard: team@1.0.0",
    "components:",
    "  - {path: ./, language: python}",
    "  - {path: backend, language: go}",
    "  - {path: web/, language: typescript}",
    "  - {path: web/admin/, language: typescript}",
    "",
  ].join("\n"),
).components;

const owner = (file: string) => {
  const o = findOwner(monorepo, file);
  return o.kind === "component" ? o.component.name : o.kind === "inferred" ? `inferred:${o.language}` : o.kind;
};

describe("findOwner — scenario 4 (monorepo)", () => {
  it.each([
    ["web/src/app.ts", "web/ (TypeScript)"],
    ["web/admin/page.tsx", "web/admin/ (TypeScript)"],
    ["backend/cmd/main.go", "backend/ (Go)"],
    ["web/scripts/build.py", "./ (Python)"],
    ["app/main.py", "./ (Python)"],
    ["tools/gen.go", "inferred:go"],
    ["service/App.java", "inferred:java"],
    ["docs/guide.md", "out-of-scope"],
    ["Makefile", "out-of-scope"],
    [".eslintrc", "out-of-scope"],
  ])("%s → %s", (file, expected) => {
    expect(owner(file)).toBe(expected);
  });

  it("accepts Windows separators and leading ./", () => {
    expect(owner("web\\src\\app.ts")).toBe("web/ (TypeScript)");
    expect(owner("./backend/x.go")).toBe("backend/ (Go)");
  });

  it("does not treat a sibling with a shared prefix as inside a component", () => {
    expect(owner("backend2/x.go")).toBe("inferred:go");
  });
});

describe("path normalization", () => {
  it.each([
    ["./", ""],
    [".", ""],
    ["/", ""],
    [".\\web\\", "web/"],
    ["web", "web/"],
    ["/web/", "web/"],
  ])("normalizeDir(%j) = %j", (input, expected) => {
    expect(normalizeDir(input)).toBe(expected);
  });

  it("strips repeated ./ prefixes", () => {
    expect(normalizePath("././a/b.ts")).toBe("a/b.ts");
  });
});
