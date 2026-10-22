import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_LAYERS, runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { goSettingsLayer } from "../src/layers/settings-go.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-go-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const DECL =
  "standard: team@1.0.0\ncomponents:\n  - {path: backend/, language: go}\n  - {path: web/, language: typescript}\n";
const GOLANGCI = `version: "2"
linters:
  enable: [gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard]
  settings:
    gocognit: {min-complexity: 15}
    depguard: {rules: {main: {deny: [{pkg: io/ioutil}]}}}
formatters:
  enable: [gofumpt, goimports]
`;

const run = (cwd: string) => runCheck({ cwd, today: TODAY }, [declarationLayer, goSettingsLayer]);

describe("goSettingsLayer", () => {
  it("is registered after the declaration layer", () => {
    expect(CHECK_LAYERS.map((l) => l.id).slice(0, 1)).toEqual(["declaration"]);
    expect(CHECK_LAYERS).toContain(goSettingsLayer);
  });

  it("checks each Go component's own .golangci.yml and go.mod", async () => {
    const cwd = project({
      ".devguard.yaml": DECL,
      "backend/.golangci.yml": GOLANGCI,
      "backend/go.mod": "module x\n\ngo 1.24\n",
    });
    const r = await run(cwd);
    expect(rules(r.findings)).toEqual(["error:settings/gomod-go-version"]);
    expect(r.findings[0]).toMatchObject({ component: "backend/ (Go)", file: "backend/go.mod" });
  });

  it("reports missing settings files", async () => {
    const r = await run(project({ ".devguard.yaml": DECL }));
    expect(rules(r.findings)).toEqual(["error:settings/golangci-missing", "error:settings/gomod-missing"]);
    expect(r.findings.map((f) => f.file)).toEqual(["backend/.golangci.yml", "backend/go.mod"]);
  });

  it("does nothing without a resolved declaration", async () => {
    expect((await run(project({}))).findings.map((f) => f.rule)).toEqual(["declaration/missing"]);
  });
});
