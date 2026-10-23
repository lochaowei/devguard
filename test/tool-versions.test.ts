import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { toolVersionsLayer } from "../src/layers/tool-versions.ts";
import type { ToolRequest, ToolRunner } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const uvLock = (ruff: string) => `version = 1\n\n[[package]]\nname = "ruff"\nversion = "${ruff}"\n`;

const PYTHON = "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: python}\n";
const PYTHON_BLOCK = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";

/** A runner that answers `golangci-lint --version` and records what was asked. */
function fakeTools(stdout: string): ToolRunner & { calls: ToolRequest[] } {
  const calls: ToolRequest[] = [];
  return {
    calls,
    run(req) {
      calls.push(req);
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
  };
}

async function check(files: Record<string, string>, tools: ToolRunner = fakeTools("")) {
  return runCheck({ cwd: project(files), today: TODAY, tools }, [declarationLayer, toolVersionsLayer]);
}

describe("pre-commit framework revs (SPEC §8)", () => {
  const config = (rev: string) =>
    [
      "repos:",
      "  - repo: https://github.com/astral-sh/ruff-pre-commit",
      `    rev: ${rev}`,
      "    hooks: [{id: ruff}]",
      "  - repo: https://github.com/example/unknown",
      "    rev: v9.9.9",
      "    hooks: [{id: x}]",
      "  - repo: local",
      "    hooks: [{id: devguard, name: devguard, entry: devguard hook git-pre-commit, language: unsupported}]",
      "",
    ].join("\n");

  it("hints when another tool's hook rev differs from the version the project locks", async () => {
    const r = await check({
      ".devguard.yaml": PYTHON,
      "uv.lock": uvLock("0.17.2"),
      ".pre-commit-config.yaml": config("v0.17.0"),
    });
    expect(rules(r.findings)).toEqual(["hint:tool-version/pre-commit-rev"]);
    expect(r.findings[0]).toMatchObject({ layer: "consistency", file: ".pre-commit-config.yaml" });
    expect(r.findings[0]?.message).toContain("0.17.2");
    expect(r.findings[0]?.message).toContain("v0.17.0");
  });

  it("is quiet when the rev matches (with or without a leading v) or nothing is locked", async () => {
    for (const rev of ["v0.17.2", "0.17.2"]) {
      const files = { ".devguard.yaml": PYTHON, "uv.lock": uvLock("0.17.2"), ".pre-commit-config.yaml": config(rev) };
      expect((await check(files)).findings).toEqual([]);
    }
    expect((await check({ ".devguard.yaml": PYTHON, ".pre-commit-config.yaml": config("v0.1.0") })).findings).toEqual(
      [],
    );
  });
});

describe("tool version consistency (SPEC §8)", () => {
  it("reports a locked version outside the standard's range as an error", async () => {
    const r = await check({ ".devguard.yaml": PYTHON, "uv.lock": uvLock("0.19.0") });
    expect(rules(r.findings)).toEqual(["error:tool-version/out-of-range"]);
    const [f] = r.findings;
    expect(f).toMatchObject({ layer: "consistency", component: "./ (Python)", file: "uv.lock" });
    expect(f?.message).toContain("ruff 0.19.0");
    expect(f?.message).toContain(">=0.17,<0.18");
    expect(f?.fix).toContain("tools.ruff");
  });

  it("accepts versions inside the range and ignores tools the project does not lock", async () => {
    const r = await check({ ".devguard.yaml": PYTHON, "uv.lock": uvLock("0.17.4") });
    expect(r.findings).toEqual([]);
    const none = await check({ ".devguard.yaml": PYTHON });
    expect(none.findings).toEqual([]);
  });

  it("checks against a range widened in the declaration, which is reported as a deviation", async () => {
    const decl = `${PYTHON_BLOCK}    overrides:\n      tools.ruff: {value: ">=0.17,<0.20", reason: "升級中", until: 2027-01-31}\n`;
    const r = await check({ ".devguard.yaml": decl, "uv.lock": uvLock("0.19.0") });
    expect(rules(r.findings)).toEqual(["deviation:declaration/deviation"]);
  });

  it("still checks against the standard's range when the widening has no reason", async () => {
    const decl = `${PYTHON_BLOCK}    overrides:\n      tools.ruff: {value: ">=0.17,<0.20"}\n`;
    const r = await check({ ".devguard.yaml": decl, "uv.lock": uvLock("0.19.0") });
    expect(rules(r.findings)).toEqual(["error:declaration/looser-without-reason", "error:tool-version/out-of-range"]);
  });

  it("reads each language's own pinning: npm lockfile, go.mod tool, build plugins", async () => {
    const decl = [
      "standard: team@1.0.0",
      "components:",
      "  - {path: web/, language: typescript}",
      "  - {path: svc/, language: go}",
      "  - {path: api/, language: java}",
    ].join("\n");
    const r = await check(
      {
        ".devguard.yaml": decl,
        "web/package-lock.json": JSON.stringify({ packages: { "node_modules/eslint": { version: "9.30.0" } } }),
        "svc/go.mod": "module x\n\ntool mvdan.cc/gofumpt\n\nrequire mvdan.cc/gofumpt v0.1.0\n",
        "api/pom.xml":
          "<project><build><plugins><plugin><artifactId>maven-pmd-plugin</artifactId><version>2.0</version></plugin></plugins></build></project>",
      },
      fakeTools("golangci-lint has version 2.12.1 built with go1.26.0"),
    );
    expect(r.findings.map((f) => [f.rule, f.file, f.component])).toEqual([
      ["tool-version/out-of-range", "web/package-lock.json", "web/ (TypeScript)"],
      ["tool-version/out-of-range", "svc/go.mod", "svc/ (Go)"],
      ["tool-version/out-of-range", "api/pom.xml", "api/ (Java)"],
    ]);
  });
});

describe("golangci-lint from PATH (SPEC §5.2 exception)", () => {
  const GO = "standard: team@1.0.0\ncomponents:\n  - {path: svc/, language: go}\n  - {path: cli/, language: go}\n";

  it("asks the PATH binary for its version once and accepts one inside the range", async () => {
    const tools = fakeTools("golangci-lint has version 2.12.1 built with go1.26.0 from abc on 2026-09-01\n");
    const r = await check({ ".devguard.yaml": GO }, tools);
    expect(r.findings).toEqual([]);
    expect(tools.calls).toEqual([{ language: "go", tool: "golangci-lint", dir: "svc/", args: ["--version"] }]);
  });

  it("reports a version outside the range and asks for a binary in the range on PATH", async () => {
    const r = await check({ ".devguard.yaml": GO }, fakeTools("golangci-lint has version v2.11.4 built with go1.25"));
    expect(rules(r.findings)).toEqual(["error:tool-version/golangci-lint", "error:tool-version/golangci-lint"]);
    expect(r.findings[0]?.message).toContain("2.11.4");
    expect(r.findings[0]?.fix).toBe("把版本在 >=2.12,<3 內的 golangci-lint binary 放進 PATH");
    expect(r.findings[0]?.layer).toBe("environment");
  });

  it("reports output it cannot read a version from", async () => {
    const r = await check({ ".devguard.yaml": GO }, fakeTools("something else"));
    expect(r.findings[0]?.message).toContain("無法");
  });

  it("does not run it without a Go component", async () => {
    const tools = fakeTools("");
    await check({ ".devguard.yaml": PYTHON }, tools);
    expect(tools.calls).toEqual([]);
  });
});
