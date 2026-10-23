import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDeclaration } from "../src/check.ts";
import { parseDeclaration } from "../src/declaration/parse.ts";
import { resolveDeclaration } from "../src/declaration/resolve.ts";
import { team_1_0_0 } from "../src/standard/team-1.0.0.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(declaration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  if (declaration !== undefined) writeFileSync(join(dir, ".devguard.yaml"), declaration);
  return dir;
}

describe("checkDeclaration", () => {
  it("reports a missing declaration with a fix", async () => {
    const r = await checkDeclaration(project(), TODAY);
    expect(rules(r.findings)).toEqual(["error:declaration/missing"]);
    expect(r.findings[0]?.fix).toContain(".devguard.yaml");
  });

  it("returns parse findings when the YAML is unreadable", async () => {
    const r = await checkDeclaration(project("standard: [\n"), TODAY);
    expect(r.standard).toBeUndefined();
    expect(r.findings[0]?.rule).toBe("declaration/yaml-syntax");
  });

  it("combines parse and resolve findings", async () => {
    const r = await checkDeclaration(
      project(
        "standard: team@1.0.0\nextra: 1\ncomponents:\n  - {path: ./, language: go, overrides: {coverage.lines: 50}}\n",
      ),
      TODAY,
    );
    expect(r.standard).toBe("team@1.0.0");
    expect(r.components.map((c) => c.name)).toEqual(["./ (Go)"]);
    expect(rules(r.findings)).toEqual(["error:declaration/shape", "error:declaration/looser-without-reason"]);
  });

  it("rethrows read errors other than a missing file", async () => {
    const dir = project();
    await expect(checkDeclaration(join(dir, "\0bad"), TODAY)).rejects.toThrow();
  });
});

describe("deprecated standards", () => {
  const decl = parseDeclaration("standard: team@1.0.0\ncomponents: []\n", ".devguard.yaml").declaration;
  if (!decl) throw new Error("unparseable");
  const deprecated = (until: string) => [{ ...team_1_0_0, deprecated: { until } }];

  it("hints before the deadline and errors after it", () => {
    expect(rules(resolveDeclaration(decl, TODAY, deprecated("2027-01-01")).findings)).toEqual([
      "hint:standard/deprecated",
    ]);
    expect(rules(resolveDeclaration(decl, TODAY, deprecated("2026-01-01")).findings)).toEqual([
      "error:standard/deprecated",
    ]);
  });
});
