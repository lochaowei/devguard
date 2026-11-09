import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { draftDeclaration } from "../src/draft.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { pythonSettingsLayer } from "../src/layers/settings-python.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, pyproject, repo } from "./standard-helpers.ts";

// pyright / basedpyright with typeCheckingMode = "off" check nothing (#114).

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

  it("keeps mypy when a pyrightconfig.json next to an on [tool.basedpyright] turns checking off", async () => {
    const files = {
      "pyproject.toml": pyproject(MYPY + '\n[tool.basedpyright]\ntypeCheckingMode = "strict"\n'),
      "pyrightconfig.json": '{ "typeCheckingMode": "off" }\n',
      "app.py": "",
    };
    expect(await draft(files)).not.toContain("typecheck.tool");
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

  it("takes a pyrightconfig.json next to pyproject.toml over its table, as pyright does", async () => {
    const based = (table: string, config: string) =>
      settingsFindings({
        ".devguard.yaml": declaring("basedpyright"),
        "pyproject.toml": pyproject(`\n[tool.basedpyright]\ntypeCheckingMode = "${table}"\n`),
        "pyrightconfig.json": `{ "typeCheckingMode": "${config}" }\n`,
      });
    const off = await based("strict", "off");
    expect(rules(off)).toEqual(["error:settings/typecheck-off"]);
    expect(off[0]?.file).toBe("pyrightconfig.json");
    expect(await based("off", "strict")).toEqual([]);
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
