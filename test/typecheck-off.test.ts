import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { draftDeclaration } from "../src/draft.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { pythonSettingsLayer } from "../src/layers/settings-python.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, repo } from "./standard-helpers.ts";

// pyright / basedpyright with typeCheckingMode = "off" check nothing (#114).

/** A pyproject.toml that meets the standard except for the type checker tables, which `typecheck` supplies. */
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

const MYPY = '\n[tool.mypy]\nstrict = true\npython_version = "3.11"\n';
const BASED_OFF = '\n[tool.basedpyright]\ntypeCheckingMode = "off"\n';

const declaring = (tool: string, overrides = "") =>
  `standard: team@1.4.0\ncomponents:\n  - path: ./\n    language: python\n    overrides:\n      typecheck.tool: ${tool}\n${overrides}`;

const settingsFindings = async (files: Record<string, string>) =>
  (await runCheck({ cwd: repo(files), today: TODAY, tools: noTools }, [declarationLayer, pythonSettingsLayer]))
    .findings;

const draft = async (files: Record<string, string>) =>
  (await draftDeclaration({ cwd: repo(files), today: TODAY, files: Object.keys(files) })).text;

describe("draft does not infer the type checker from settings that turn it off (#114)", () => {
  it("keeps mypy when [tool.basedpyright] is off and [tool.mypy] is set", async () => {
    const text = await draft({ "pyproject.toml": pyproject(MYPY + BASED_OFF), "app.py": "" });
    expect(text).not.toContain("typecheck.tool");
    expect(text).not.toContain("typecheck.strict");
  });

  it("keeps mypy when pyrightconfig.json is off", async () => {
    const files = {
      "pyproject.toml": pyproject(MYPY),
      "pyrightconfig.json": '{ "typeCheckingMode": "off" }\n',
      "app.py": "",
    };
    const text = await draft(files);
    expect(text).not.toContain("typecheck.tool");
    expect(text).not.toContain("typecheck.strict");
  });

  it("still infers basedpyright from a table that type-checks", async () => {
    const text = await draft({
      "pyproject.toml": pyproject('\n[tool.basedpyright]\ntypeCheckingMode = "standard"\n'),
      "app.py": "",
    });
    expect(text).toContain("typecheck.tool: basedpyright");
  });
});

describe("a declared pyright-based checker set to off is an error (#114)", () => {
  it("reports basedpyright's typeCheckingMode = off as an error that fix sets to strict", async () => {
    const findings = await settingsFindings({
      ".devguard.yaml": declaring("basedpyright"),
      "pyproject.toml": pyproject(BASED_OFF),
    });
    expect(rules(findings)).toEqual(["error:settings/typecheck-off"]);
    expect(findings[0]?.repairs).toEqual([
      { op: "set", file: "pyproject.toml", path: ["tool", "basedpyright", "typeCheckingMode"], value: "strict" },
    ]);
  });

  it("is still an error when the declaration relaxes typecheck.strict; fix sets pyright's default", async () => {
    const relaxed = '      typecheck.strict:\n        value: false\n        reason: "legacy code"\n';
    const findings = await settingsFindings({
      ".devguard.yaml": declaring("pyright", relaxed),
      "pyproject.toml": pyproject(""),
      "pyrightconfig.json": '{ "typeCheckingMode": "off", "pythonVersion": "3.11" }\n',
    });
    expect(rules(findings).filter((r) => r.startsWith("error"))).toEqual(["error:settings/typecheck-off"]);
    const off = findings.find((f) => f.rule === "settings/typecheck-off");
    expect(off?.file).toBe("pyrightconfig.json");
    expect(off?.repairs).toEqual([
      { op: "set", file: "pyrightconfig.json", path: ["typeCheckingMode"], value: "standard" },
    ]);
  });

  it("says nothing about an undeclared checker that is off", async () => {
    const findings = await settingsFindings({
      ".devguard.yaml": "standard: team@1.4.0\ncomponents:\n  - path: ./\n    language: python\n",
      "pyproject.toml": pyproject(MYPY + BASED_OFF),
    });
    expect(findings).toEqual([]);
  });

  it("keeps basic and standard as a looser typecheck.strict", async () => {
    for (const mode of ["basic", "standard"]) {
      const toml = pyproject(`\n[tool.basedpyright]\ntypeCheckingMode = "${mode}"\n`);
      const findings = await settingsFindings({ ".devguard.yaml": declaring("basedpyright"), "pyproject.toml": toml });
      expect(rules(findings)).toEqual(["error:settings/looser"]);
    }
  });
});
