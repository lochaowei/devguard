import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { pythonSettingsLayer } from "../src/layers/python-settings.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PY = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";

/** The declaration with overrides for the root component. */
const withOverrides = (...lines: string[]): string =>
  PY + "    overrides:\n" + lines.map((l) => `      ${l}\n`).join("");

/** A pyproject.toml that meets team@1.0.0 exactly. */
const GOOD = `[project]
name = "app"
requires-python = ">=3.11"

[tool.ruff]
line-length = 120
target-version = "py311"

[tool.ruff.lint]
select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]

[tool.ruff.lint.mccabe]
max-complexity = 10

[tool.ruff.lint.per-file-ignores]
"**/tests/**" = ["S101"]
"**/test_*.py" = ["S101"]

[tool.mypy]
strict = true

[tool.coverage.run]
branch = true
`;

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-py-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function check(files: Record<string, string>) {
  const r = await runCheck({ cwd: project(files), today: TODAY }, [declarationLayer, pythonSettingsLayer]);
  return r.findings.map((f) => ({ level: f.level, rule: f.rule, file: f.file, message: f.message }));
}

/** Replaces one line of GOOD (must exist) with another. */
function edit(from: string, to: string, base = GOOD): string {
  if (!base.includes(from)) throw new Error(`not in fixture: ${from}`);
  return base.replace(from, to);
}

describe("python settings layer", () => {
  it("passes a pyproject.toml that matches the standard", async () => {
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": GOOD })).toEqual([]);
  });

  it("reports extend-select instead of lint.select", async () => {
    const toml = edit("select = [", "extend-select = [");
    const findings = await check({ ".devguard.yaml": PY, "pyproject.toml": toml });
    expect(findings).toContainEqual(
      expect.objectContaining({ level: "error", rule: "python-settings/ruff-extend-select", file: "pyproject.toml" }),
    );
  });

  it("reports rule groups missing from lint.select, naming them", async () => {
    const toml = edit('"N", "S", "TID"]', '"N"]');
    const findings = await check({ ".devguard.yaml": PY, "pyproject.toml": toml });
    expect(findings).toEqual([expect.objectContaining({ level: "error", rule: "python-settings/ruff-rules-missing" })]);
    expect(findings[0]?.message).toContain("S、TID");
  });

  it("accepts a broader prefix or ALL as covering a rule group, and hints at extra groups", async () => {
    const broader = edit('"C90", "SIM"', '"C", "SIM", "PL"');
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": broader })).toEqual([
      expect.objectContaining({ level: "hint", rule: "python-settings/ruff-rules-extra" }),
    ]);
    const all = edit('select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]', 'select = ["ALL"]');
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": all })).toEqual([
      expect.objectContaining({ level: "hint", rule: "python-settings/ruff-rules-extra" }),
    ]);
  });

  it("reports a Ruff section with no lint.select, and a missing Ruff section", async () => {
    const noSelect = edit('select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]\n', "");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": noSelect })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/ruff-rules-missing" }),
    ]);
    const noRuff = GOOD.replace(/\[tool\.ruff[\s\S]*?(?=\[tool\.mypy\])/, "");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": noRuff })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/ruff-missing" }),
    ]);
  });

  it("compares max-complexity with the declaration: looser is an error, stricter a hint", async () => {
    const looser = edit("max-complexity = 10", "max-complexity = 15");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": looser })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
    ]);
    const stricter = edit("max-complexity = 10", "max-complexity = 8");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": stricter })).toEqual([
      expect.objectContaining({ level: "hint", rule: "python-settings/stricter" }),
    ]);
    const tightened = withOverrides("complexity.cyclomatic: 8");
    expect(await check({ ".devguard.yaml": tightened, "pyproject.toml": stricter })).toEqual([]);
    expect(await check({ ".devguard.yaml": tightened, "pyproject.toml": GOOD })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
    ]);
  });

  it("takes Ruff's own default when max-complexity is not set", async () => {
    const unset = edit("[tool.ruff.lint.mccabe]\nmax-complexity = 10\n", "");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": unset })).toEqual([]);
    const tightened = withOverrides("complexity.cyclomatic: 8");
    const [finding] = await check({ ".devguard.yaml": tightened, "pyproject.toml": unset });
    expect(finding).toMatchObject({ level: "error", rule: "python-settings/looser" });
    expect(finding?.message).toContain("Ruff 預設");
  });

  it("reports a line-length that differs from the declaration", async () => {
    const narrow = edit("line-length = 120", "line-length = 100");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": narrow })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/style-mismatch" }),
    ]);
    expect(
      await check({ ".devguard.yaml": withOverrides("format.lineLength: 100"), "pyproject.toml": narrow }),
    ).toEqual([]);
    const unset = edit("line-length = 120\n", "");
    expect(await check({ ".devguard.yaml": PY, "pyproject.toml": unset })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/style-mismatch" }),
    ]);
  });

  describe("Python version", () => {
    it("reports a target-version below the standard minimum, and hints at a higher one", async () => {
      const lower = edit('target-version = "py311"', 'target-version = "py310"');
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": lower })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
      ]);
      const higher = edit('target-version = "py311"', 'target-version = "py312"');
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": higher })).toEqual([
        expect.objectContaining({ level: "hint", rule: "python-settings/stricter" }),
      ]);
    });

    it("follows a requires-python above the standard minimum without false reports", async () => {
      const py312 = edit('requires-python = ">=3.11"', 'requires-python = ">=3.12"');
      const both = edit('target-version = "py311"', 'target-version = "py312"', py312);
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": both })).toEqual([]);
      const mypy = edit("strict = true", 'strict = true\npython_version = "3.12"', both);
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": mypy })).toEqual([]);
      const inferred = edit('target-version = "py311"\n', "", py312);
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": inferred })).toEqual([]);
      const pinned = edit('requires-python = ">=3.11"', 'requires-python = "~=3.13.1, !=3.13.4"');
      const py313 = edit('target-version = "py311"', 'target-version = "py313"', pinned);
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": py313 })).toEqual([]);
    });

    it("reports a target-version below the project's own requires-python", async () => {
      const py312 = edit('requires-python = ">=3.11"', 'requires-python = ">=3.12"');
      const [finding] = await check({ ".devguard.yaml": PY, "pyproject.toml": py312 });
      expect(finding).toMatchObject({ level: "error", rule: "python-settings/looser" });
      expect(finding?.message).toContain("requires-python");
    });

    it("reports a requires-python below the standard minimum", async () => {
      const py39 = edit('requires-python = ">=3.11"', 'requires-python = ">=3.9"');
      const [finding] = await check({ ".devguard.yaml": PY, "pyproject.toml": py39 });
      expect(finding).toMatchObject({ level: "error", rule: "python-settings/looser" });
      expect(finding?.message).toContain("requires-python");
    });

    it("reports a target-version that is missing when nothing else gives one, or malformed", async () => {
      const bare = edit('requires-python = ">=3.11"\n', "", edit('target-version = "py311"\n', ""));
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": bare })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/target-version-missing" }),
      ]);
      const odd = edit('target-version = "py311"', 'target-version = "python3"');
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": odd })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/invalid-setting" }),
      ]);
    });

    it("compares mypy's python_version too", async () => {
      const mypy = edit("strict = true", 'strict = true\npython_version = "3.10"');
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": mypy })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
      ]);
    });
  });

  describe("type checking", () => {
    it("reports mypy without strict", async () => {
      for (const toml of [
        edit("strict = true", "strict = false"),
        edit("strict = true", "warn_unused_configs = true"),
      ]) {
        expect(await check({ ".devguard.yaml": PY, "pyproject.toml": toml })).toEqual([
          expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
        ]);
      }
    });

    it("reports a missing [tool.mypy]", async () => {
      const toml = edit("[tool.mypy]\nstrict = true\n", "");
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": toml })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/typecheck-missing" }),
      ]);
    });

    it("checks pyright's typeCheckingMode when the declaration picks pyright", async () => {
      const decl = withOverrides("typecheck.tool: pyright");
      const strict = edit("[tool.mypy]\nstrict = true", '[tool.pyright]\ntypeCheckingMode = "strict"');
      expect(await check({ ".devguard.yaml": decl, "pyproject.toml": strict })).toEqual([]);
      const basic = edit('"strict"', '"standard"', strict);
      expect(await check({ ".devguard.yaml": decl, "pyproject.toml": basic })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/looser" }),
      ]);
    });

    it("hints when mypy is strict although the declaration relaxed it", async () => {
      const decl = withOverrides("typecheck.strict: {value: false, reason: 舊程式碼}");
      const findings = await check({ ".devguard.yaml": decl, "pyproject.toml": GOOD });
      expect(findings).toContainEqual(expect.objectContaining({ level: "hint", rule: "python-settings/stricter" }));
      expect(findings.filter((f) => f.level === "error")).toEqual([]);
    });
  });

  describe("asserts in tests (SPEC §6.1: test files relax S101)", () => {
    const IGNORES = '"**/tests/**" = ["S101"]\n"**/test_*.py" = ["S101"]\n';

    it("reports per-file-ignores without S101 for test files and repairs it", async () => {
      const toml = edit(IGNORES, "");
      const r = await runCheck({ cwd: project({ ".devguard.yaml": PY, "pyproject.toml": toml }), today: TODAY }, [
        declarationLayer,
        pythonSettingsLayer,
      ]);
      expect(r.findings).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/ruff-test-asserts" }),
      ]);
      const ignores = ["tool", "ruff", "lint", "per-file-ignores"];
      expect(r.findings[0]?.repairs).toEqual([
        { op: "set", file: "pyproject.toml", path: [...ignores, "**/tests/**"], value: ["S101"] },
        { op: "set", file: "pyproject.toml", path: [...ignores, "**/test_*.py"], value: ["S101"] },
      ]);
    });

    it("accepts any test pattern that ignores S101 (or all of S)", async () => {
      const own = edit(IGNORES, '"t/*.py" = ["S", "E501"]\n');
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": own })).toEqual([]);
    });

    it("does not ask for it when the declaration drops the S rules", async () => {
      const rules = '["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "TID"]';
      const decl = withOverrides(`lint.rules: {value: ${rules}, reason: 舊程式碼}`);
      const toml = edit('"N", "S", "TID"]', '"N", "TID"]', edit(IGNORES, ""));
      const findings = await check({ ".devguard.yaml": decl, "pyproject.toml": toml });
      expect(findings.filter((f) => f.level === "error")).toEqual([]);
    });
  });

  it("writes mypy's python_version from python.minVersion when it creates [tool.mypy] (SPEC §6.1)", async () => {
    const toml = edit("[tool.mypy]\nstrict = true\n", "");
    const r = await runCheck({ cwd: project({ ".devguard.yaml": PY, "pyproject.toml": toml }), today: TODAY }, [
      declarationLayer,
      pythonSettingsLayer,
    ]);
    expect(r.findings[0]?.repairs).toContainEqual({
      op: "set",
      file: "pyproject.toml",
      path: ["tool", "mypy", "python_version"],
      value: "3.11",
    });
  });

  it("reports coverage without branch = true", async () => {
    for (const toml of [edit("branch = true", "branch = false"), edit("[tool.coverage.run]\nbranch = true\n", "")]) {
      expect(await check({ ".devguard.yaml": PY, "pyproject.toml": toml })).toEqual([
        expect.objectContaining({ level: "error", rule: "python-settings/coverage-branch" }),
      ]);
    }
  });

  it("reports a missing or unreadable pyproject.toml, per component directory", async () => {
    const decl =
      "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: python}\n  - {path: api, language: python}\n";
    expect(await check({ ".devguard.yaml": decl, "api/pyproject.toml": "[tool.ruff\n" })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/pyproject-missing", file: "pyproject.toml" }),
      expect.objectContaining({
        level: "error",
        rule: "python-settings/pyproject-invalid",
        file: "api/pyproject.toml",
      }),
    ]);
  });

  it("checks only Python components of a resolved declaration", async () => {
    const go = "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: go}\n";
    expect(await check({ ".devguard.yaml": go })).toEqual([]);
    expect(await check({ ".devguard.yaml": "standard: team@9.9.9\ncomponents: []\n" })).toEqual([
      expect.objectContaining({ rule: "standard/newer-than-cli" }),
    ]);
  });

  it("checks the rule groups the declaration adds", async () => {
    const decl = withOverrides("lint.rules: [E, W, F, I, B, UP, C90, SIM, N, S, TID, PT]");
    expect(await check({ ".devguard.yaml": decl, "pyproject.toml": GOOD })).toEqual([
      expect.objectContaining({ level: "error", rule: "python-settings/ruff-rules-missing" }),
    ]);
  });
});
