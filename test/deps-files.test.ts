import { describe, expect, it } from "vitest";
import { isDependencyFile } from "../src/deps/manifests.ts";

describe("dependency files (pre-commit runs the deps rules only when one is staged, SPEC §7.1)", () => {
  it("recognises manifests and lockfiles in any directory", () => {
    for (const f of ["package.json", "web/pnpm-lock.yaml", "api/requirements-dev.txt", "go.sum", "svc/pom.xml"]) {
      expect(isDependencyFile(f)).toBe(true);
    }
  });

  it("ignores code and other config", () => {
    for (const f of ["src/app.ts", "tsconfig.json", "README.md", "web/package.json.bak"]) {
      expect(isDependencyFile(f)).toBe(false);
    }
  });
});
