import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { runDoctor } from "../src/doctor.ts";
import { draftDeclaration } from "../src/draft.ts";
import { createStandardUpgradeCheck } from "../src/environment/standard-upgrade.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { pythonSettingsLayer } from "../src/layers/settings-python.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, repo } from "./standard-helpers.ts";

// team@1.2.0 as this CLI bundles it (#68): basedpyright is an allowed type checker.

const pythonWith = (standard: string, overrides: string) =>
  `standard: ${standard}\ncomponents:\n  - path: ./\n    language: python\n    overrides:\n${overrides}`;

const declarationErrors = async (text: string) =>
  rules(
    (await runCheck({ cwd: repo({ ".devguard.yaml": text }), today: TODAY, tools: noTools }, [declarationLayer]))
      .findings,
  );

describe("team@1.2.0 allows basedpyright as the type checker (#68)", () => {
  it("accepts typecheck.tool: basedpyright without a reason; team@1.1.0 still does not", async () => {
    const overrides = "      typecheck.tool: basedpyright\n";
    expect(await declarationErrors(pythonWith("team@1.2.0", overrides))).toEqual([]);
    expect(await declarationErrors(pythonWith("team@1.1.0", overrides))).not.toEqual([]);
  });
});

describe("team@1.2.0 is the newest bundled standard (#68)", () => {
  it("doctor suggests upgrading team@1.1.0 to team@1.2.0", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.1.0\ncomponents: []\n" });
    const { findings } = await runDoctor({ cwd: dir, today: TODAY, checks: [createStandardUpgradeCheck()] });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "standard/upgrade-available", fix: "devguard standard upgrade team@1.2.0" }),
    );
  });

  it("draft writes typecheck.tool: basedpyright for a project with [tool.basedpyright]", async () => {
    const files = {
      "pyproject.toml": '[project]\nname = "app"\n\n[tool.basedpyright]\ntypeCheckingMode = "strict"\n',
      "app.py": "",
    };
    const { text } = await draftDeclaration({ cwd: repo(files), today: TODAY, files: Object.keys(files) });
    expect(text).toContain("standard: team@1.2.0");
    expect(text).toContain("typecheck.tool: basedpyright");
  });

  it("draft keeps mypy for a project without basedpyright settings", async () => {
    const files = { "pyproject.toml": '[project]\nname = "app"\n', "app.py": "" };
    const { text } = await draftDeclaration({ cwd: repo(files), today: TODAY, files: Object.keys(files) });
    expect(text).not.toContain("typecheck.tool");
  });
});

/** A pyproject.toml that meets team@1.2.0 except for the type checker table, which `typecheck` supplies. */
const pyproject = (typecheck: string) => `[project]
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
${typecheck}
[tool.coverage.run]
branch = true
`;

const BASED = pythonWith("team@1.2.0", "      typecheck.tool: basedpyright\n");

const settingsFindings = async (files: Record<string, string>) =>
  (await runCheck({ cwd: repo(files), today: TODAY, tools: noTools }, [declarationLayer, pythonSettingsLayer]))
    .findings;

describe("team@1.2.0 checks basedpyright's strict mode (#68)", () => {
  it("passes [tool.basedpyright] typeCheckingMode = strict and rejects a looser mode", async () => {
    const strict = pyproject('\n[tool.basedpyright]\ntypeCheckingMode = "strict"\n');
    expect(rules(await settingsFindings({ ".devguard.yaml": BASED, "pyproject.toml": strict }))).toEqual([]);
    const basic = pyproject('\n[tool.basedpyright]\ntypeCheckingMode = "basic"\n');
    expect(rules(await settingsFindings({ ".devguard.yaml": BASED, "pyproject.toml": basic }))).toEqual([
      "error:settings/looser",
    ]);
  });

  it("does not take [tool.pyright] or [tool.mypy] for basedpyright's settings", async () => {
    const toml = pyproject('\n[tool.pyright]\ntypeCheckingMode = "strict"\n\n[tool.mypy]\nstrict = true\n');
    const findings = await settingsFindings({ ".devguard.yaml": BASED, "pyproject.toml": toml });
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "settings/typecheck-missing",
        message: "pyproject.toml 沒有 [tool.basedpyright] 設定",
      }),
    ]);
    expect(findings[0]?.repairs).toEqual([
      { op: "set", file: "pyproject.toml", path: ["tool", "basedpyright", "typeCheckingMode"], value: "strict" },
    ]);
  });

  it("reads pyrightconfig.json, which basedpyright also reads", async () => {
    const files = { ".devguard.yaml": BASED, "pyproject.toml": pyproject("") };
    const config = (mode: string) => `{ "typeCheckingMode": "${mode}", "pythonVersion": "3.11" }`;
    expect(rules(await settingsFindings({ ...files, "pyrightconfig.json": config("strict") }))).toEqual([]);
    expect((await settingsFindings({ ...files, "pyrightconfig.json": config("basic") })).map((f) => f.file)).toEqual([
      "pyrightconfig.json",
    ]);
  });
});
