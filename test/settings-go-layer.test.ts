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

  it("checks each Go component's own .golangci.yml and go.mod, or inherits a root .golangci.yaml", async () => {
    const cwd = project({
      ".devguard.yaml": DECL,
      ".golangci.yaml": GOLANGCI,
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

  it("checks a .golangci.toml golangci-lint would use instead of reporting it missing", async () => {
    const cwd = project({
      ".devguard.yaml": DECL,
      "backend/.golangci.toml": 'version = "2"\n\n[linters]\nenable = ["gosec"]\n',
      "backend/go.mod": "module x\n\ngo 1.26\n",
    });
    const r = await run(cwd);
    expect(rules(r.findings)).not.toContain("error:settings/golangci-missing");
    expect(rules(r.findings)).toContain("error:settings/golangci-linter-missing");
    expect(new Set(r.findings.map((f) => f.file))).toEqual(new Set(["backend/.golangci.toml"]));
    const revive = r.findings.find((f) => f.message.includes("revive"));
    expect(revive?.message).toContain(".golangci.toml");
    expect(revive?.message).not.toContain(".golangci.yml");
  });

  it("checks the .golangci.toml golangci-lint picks over a .golangci.yml in the same directory, with a hint", async () => {
    const cwd = project({
      ".devguard.yaml": DECL,
      "backend/.golangci.yml": GOLANGCI,
      "backend/.golangci.toml": 'version = "2"\n',
      "backend/go.mod": "module x\n\ngo 1.26\n",
    });
    const r = await run(cwd);
    expect(rules(r.findings)).toContain("error:settings/golangci-linter-missing");
    expect(r.findings.filter((f) => f.level === "error").every((f) => f.file === "backend/.golangci.toml")).toBe(true);
    const hints = r.findings.filter((f) => f.level === "hint");
    expect(hints).toMatchObject([{ rule: "settings/golangci-multiple", file: "backend/.golangci.toml" }]);
    expect(hints[0]?.message).toContain(".golangci.yml");
  });

  it("checks the nearest directory's config, with no hint for one further up", async () => {
    const cwd = project({
      ".devguard.yaml": DECL,
      ".golangci.toml": 'version = "2"\n',
      "backend/.golangci.yml": GOLANGCI,
      "backend/go.mod": "module x\n\ngo 1.26\n",
    });
    expect(rules((await run(cwd)).findings)).toEqual([]);
  });

  it("reports a .golangci.toml or .golangci.json that does not parse, naming it, without a repair", async () => {
    for (const [name, text, rule] of [
      [".golangci.toml", 'version = "2"\n[linters\n', "settings/golangci-toml-syntax"],
      [".golangci.json", '{ "version": "2", }\n', "settings/golangci-json-syntax"],
    ] as const) {
      const cwd = project({
        ".devguard.yaml": DECL,
        [`backend/${name}`]: text,
        "backend/go.mod": "module x\n\ngo 1.26\n",
      });
      const r = await run(cwd);
      expect(rules(r.findings)).toEqual([`error:${rule}`]);
      expect(r.findings[0]).toMatchObject({ file: `backend/${name}` });
      expect(r.findings[0]?.message).toContain(name);
      expect(r.findings[0]?.line).toBeGreaterThan(0);
      expect(r.findings[0]?.repairs).toBeUndefined();
    }
  });

  describe("a golangci config several Go components share (#92)", () => {
    const GOMOD = "module x\n\ngo 1.26\n";
    const LINTERS =
      "errcheck, govet, ineffassign, staticcheck, unused, gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard";
    const decl = (...paths: string[]) =>
      `standard: team@1.0.0\ncomponents:\n${paths.map((p) => `  - {path: ${p}, language: go}\n`).join("")}`;
    // carapace: a root config without revive, used by the root component and two below it.
    const carapace = () =>
      project({
        ".devguard.yaml": decl("./", "example-multi/", "example-nonposix/"),
        ".golangci.yml": GOLANGCI.replace("revive, ", ""),
        "go.mod": GOMOD,
        "example-multi/go.mod": GOMOD,
        "example-nonposix/go.mod": GOMOD,
      });

    it("reports each finding about the shared file once, under the component in its directory", async () => {
      const r = await run(carapace());
      expect(rules(r.findings)).toEqual(["error:settings/golangci-linter-missing"]);
      expect(r.findings[0]).toMatchObject({ component: "./ (Go)", file: ".golangci.yml" });
    });

    it("reports the shared file once, under the shallowest user, when no component is in its directory", async () => {
      const cwd = project({
        ".devguard.yaml": decl("tools/b/", "app/", "tools/a/"),
        ".golangci.yml": GOLANGCI.replace("revive, ", ""),
        "app/go.mod": GOMOD,
        "tools/a/go.mod": GOMOD,
        "tools/b/go.mod": GOMOD,
      });
      const r = await run(cwd);
      expect(rules(r.findings)).toEqual(["error:settings/golangci-linter-missing"]);
      expect(r.findings[0]).toMatchObject({ component: "app/ (Go)", file: ".golangci.yml" });
    });

    it("keeps a finding only one user of the file reports, under that user", async () => {
      const cwd = project({
        ".devguard.yaml": decl("./", "sub/").replace(
          "{path: sub/, language: go}",
          `{path: sub/, language: go, overrides: {lint.rules: [${LINTERS}, gocritic]}}`,
        ),
        ".golangci.yml": GOLANGCI,
        "go.mod": GOMOD,
        "sub/go.mod": GOMOD,
      });
      const r = await run(cwd);
      expect(r.findings).toMatchObject([{ rule: "settings/golangci-linter-missing", component: "sub/ (Go)" }]);
      expect(r.findings[0]?.message).toContain("gocritic");
    });

    it("lists a finding only some users report under the shallowest of those, not the file's directory", async () => {
      const gocritic = `{language: go, overrides: {lint.rules: [${LINTERS}, gocritic]}}`;
      const cwd = project({
        ".devguard.yaml": `standard: team@1.0.0\ncomponents:\n  - {path: ./, language: go}\n  - {path: b/c/, ${gocritic.slice(1)}\n  - {path: a/, ${gocritic.slice(1)}\n`,
        ".golangci.yml": GOLANGCI,
        "go.mod": GOMOD,
        "a/go.mod": GOMOD,
        "b/c/go.mod": GOMOD,
      });
      const r = await run(cwd);
      expect(r.findings).toMatchObject([{ rule: "settings/golangci-linter-missing", component: "a/ (Go)" }]);
    });

    it("still checks each component's own go.mod", async () => {
      const cwd = project({
        ".devguard.yaml": decl("./", "sub/"),
        ".golangci.yml": GOLANGCI,
        "go.mod": "module x\n\ngo 1.24\n",
        "sub/go.mod": "module x\n\ngo 1.24\n",
      });
      const r = await run(cwd);
      expect(r.findings.map((f) => f.file)).toEqual(["go.mod", "sub/go.mod"]);
    });

    it("reports the shared file's findings when check is given only a file of another user", async () => {
      const r = await runCheck(
        { cwd: carapace(), today: TODAY, scope: { files: ["example-multi/main.go"], full: false } },
        [declarationLayer, goSettingsLayer],
      );
      // Settings layers check every component whatever the scope, so the file's owner is always there to list it.
      expect(r.findings).toMatchObject([{ rule: "settings/golangci-linter-missing", component: "./ (Go)" }]);
    });
  });

  it("does nothing without a resolved declaration", async () => {
    expect((await run(project({}))).findings.map((f) => f.rule)).toEqual(["declaration/missing"]);
  });
});
