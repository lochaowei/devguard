import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { runDoctor } from "../src/doctor.ts";
import { draftDeclaration } from "../src/draft.ts";
import { createStandardUpgradeCheck } from "../src/environment/standard-upgrade.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createDepsLayer } from "../src/layers/deps.ts";
import { javaSettingsLayer } from "../src/layers/settings-java.ts";
import { pythonSettingsLayer } from "../src/layers/settings-python.ts";
import { findStandard } from "../src/standard/registry.ts";
import { typescriptSettingsLayer } from "../src/layers/settings-typescript.ts";
import { runStandardUpgrade } from "../src/standard/upgrade-run.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";
import { checkTests, fakeTools, ok, project } from "./tests-helpers.ts";

// legacy@1.0.0 as this CLI bundles it (#37): no bundled-standard injection, so these go through the real registry.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-legacy100-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const noTools: ToolRunner = {
  run: () => Promise.reject(new Error("no tools in this test")),
  manage: () => Promise.reject(new Error("no package commands expected")),
};

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

async function upgrade(dir: string, options: { apply?: boolean; target?: string } = {}) {
  let out = "";
  const write = (t: string) => (out += t);
  const code = await runStandardUpgrade({ cwd: dir, today: TODAY, apply: false, ...options, tools: noTools, write });
  return { code, out };
}

const component = (standard: string, language: string) =>
  `standard: ${standard}\ncomponents:\n  - {path: ./, language: ${language}}\n`;

describe("legacy@1.0.0 is a bundled standard (#37)", () => {
  it("check accepts a declaration on legacy@1.0.0", async () => {
    const dir = repo({ ".devguard.yaml": component("legacy@1.0.0", "python") });
    const { findings } = await runCheck({ cwd: dir, today: TODAY, tools: noTools }, [declarationLayer]);
    expect(rules(findings)).toEqual([]);
  });
});

describe("standard upgrade moves legacy@1.0.0 to team@1.1.0 (#37)", () => {
  it("previews legacy@1.0.0 → team@1.1.0 by default, with the items it tightens", async () => {
    const dir = repo({ ".devguard.yaml": component("legacy@1.0.0", "typescript") });
    const { code, out } = await upgrade(dir);
    expect(code).toBe(1);
    expect(out).toContain("legacy@1.0.0 → team@1.1.0");
    expect(out).toContain("TypeScript｜覆蓋率門檻 (%)：0 → 80");
    expect(out).toContain("TypeScript｜tsconfig strict：false → true");
    expect(out).toContain("TypeScript｜循環複雜度上限：20 → 10");
    expect(out).toContain('TypeScript｜禁用套件：["request"] → ["moment", "request", "node-fetch"]');
    expect(read(dir, ".devguard.yaml")).toBe(component("legacy@1.0.0", "typescript"));
  });

  it("--apply moves the declaration to team@1.1.0", async () => {
    const dir = repo({ ".devguard.yaml": component("legacy@1.0.0", "go") });
    expect((await upgrade(dir, { apply: true })).code).toBe(0);
    expect(read(dir, ".devguard.yaml")).toMatch(/^standard: team@1\.1\.0\n/);
  });

  it("refuses team@1.0.0, which is older than the team@1.1.0 legacy starts from", async () => {
    const dir = repo({ ".devguard.yaml": component("legacy@1.0.0", "python") });
    const { code, out } = await upgrade(dir, { target: "team@1.0.0" });
    expect(code).toBe(2);
    expect(out).toBe("無法從 legacy@1.0.0 升級到 team@1.0.0；可以升級到 team@1.1.0\n");
  });

  it("never moves team to legacy", async () => {
    const dir = repo({ ".devguard.yaml": component("team@1.1.0", "python") });
    expect(await upgrade(dir)).toEqual({ code: 0, out: "已經是這個 devguard 內建的最新標準 team@1.1.0\n" });
    expect(await upgrade(dir, { target: "legacy@1.0.0" })).toEqual({
      code: 2,
      out: "無法從 team@1.1.0 升級到 legacy@1.0.0\n",
    });
  });
});

describe("doctor and draft stay on team (#37)", () => {
  const upgradeHints = async (standard: string) => {
    const dir = repo({ ".devguard.yaml": `standard: ${standard}\ncomponents: []\n` });
    const { findings } = await runDoctor({ cwd: dir, today: TODAY, checks: [createStandardUpgradeCheck()] });
    return findings.filter((f) => f.rule === "standard/upgrade-available").map((f) => f.fix);
  };

  it("doctor suggests no move from team to legacy", async () => {
    expect(await upgradeHints("team@1.1.0")).toEqual([]);
    expect(await upgradeHints("team@1.0.0")).toEqual(["devguard standard upgrade team@1.1.0"]);
  });

  it("doctor does not offer legacy → team as an update that cannot fail the project", async () => {
    expect(await upgradeHints("legacy@1.0.0")).toEqual([]);
  });

  it("draft writes team@1.1.0, not legacy", async () => {
    const cwd = repo({ "pyproject.toml": "[project]\nname = 'app'\n", "app/main.py": "" });
    const { text } = await draftDeclaration({ cwd, today: TODAY, files: ["pyproject.toml", "app/main.py"] });
    expect(text).toContain("standard: team@1.1.0");
  });
});

describe("legacy@1.0.0 admits a Java 8 project on JUnit 4 (#37)", () => {
  const POM =
    "<project><properties><maven.compiler.release>1.8</maven.compiler.release></properties><dependencies>" +
    "<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency>" +
    "<dependency><groupId>log4j</groupId><artifactId>log4j</artifactId><version>1.2.17</version></dependency>" +
    "</dependencies></project>";

  const findings = async (standard: string) => {
    const dir = repo({ ".devguard.yaml": component(standard, "java"), "pom.xml": POM });
    const deps = createDepsLayer({ trackedFiles: () => Promise.resolve([".devguard.yaml", "pom.xml"]) });
    const r = await runCheck({ cwd: dir, today: TODAY, tools: noTools }, [declarationLayer, javaSettingsLayer, deps]);
    return r.findings
      .filter((f) => /maven.compiler.release|禁用套件/.test(f.message))
      .map((f) => `${f.level}:${f.message}`);
  };

  it("accepts Java 8 and JUnit 4 but still bans log4j 1.x", async () => {
    expect(await findings("legacy@1.0.0")).toEqual(["error:直接依賴了禁用套件 log4j:log4j"]);
  });

  it("states java.minVersion 8 itself instead of inheriting it from team@1.1.0", () => {
    expect(findStandard("legacy@1.0.0")).toMatchObject({
      ok: true,
      standard: { languages: { java: { "java.minVersion": { value: "8" } } } },
    });
  });
});

describe("legacy@1.0.0 admits a TypeScript project without coverage gates or strict types (#37)", () => {
  const files = (standard: string) => ({
    ".devguard.yaml": component(standard, "typescript"),
    "tsconfig.json": '{ "compilerOptions": { "target": "es2017" } }',
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
    "eslint.config.js":
      'import tseslint from "typescript-eslint";\n' +
      'export default [tseslint.configs.strictTypeChecked, { rules: { complexity: ["error", 20] } }];\n',
    "vitest.config.ts": 'export default { test: { coverage: { include: ["src/**/*.ts"] } } };\n',
  });

  const errors = async (standard: string, change: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = { ...files(standard), ...change };
    const dir = repo(Object.fromEntries(Object.entries(all).flatMap(([name, text]) => (text ? [[name, text]] : []))));
    const { findings } = await runCheck({ cwd: dir, today: TODAY, listFiles: () => Promise.resolve([]) }, [
      declarationLayer,
      typescriptSettingsLayer,
    ]);
    return findings.filter((f) => f.level === "error").map((f) => f.message);
  };

  it("passes on legacy@1.0.0 what team@1.1.0 rejects", async () => {
    expect(await errors("team@1.1.0")).toEqual([
      expect.stringContaining("tsconfig strict"),
      expect.stringContaining("noUncheckedIndexedAccess"),
      expect.stringContaining("noImplicitOverride"),
      expect.stringContaining("noFallthroughCasesInSwitch"),
      expect.stringContaining("complexity"),
      expect.stringContaining("coverage.thresholds"),
    ]);
    expect(await errors("legacy@1.0.0")).toEqual([]);
  });

  it("check --full runs the tests but does not ask for a coverage report", async () => {
    const passed = JSON.stringify({
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [{ name: "a.test.ts", status: "passed", assertionResults: [{ fullName: "a", status: "passed" }] }],
    });
    const on = async (standard: string) => {
      const { tools, calls } = fakeTools(() => ok(passed));
      const r = await checkTests(project(component(standard, "typescript")), tools, ["a.ts"]);
      return { rules: rules(r.findings), ran: calls.length };
    };
    expect(await on("team@1.1.0")).toEqual({ rules: ["error:coverage/no-report"], ran: 1 });
    expect(await on("legacy@1.0.0")).toEqual({ rules: [], ran: 1 });
  });

  it("lets Python run mypy without strict and coverage without branch measurement", async () => {
    const on = async (standard: string) => {
      const dir = repo({
        ".devguard.yaml": component(standard, "python"),
        "pyproject.toml": '[project]\nname = "app"\n\n[tool.mypy]\npython_version = "3.11"\n',
      });
      const r = await runCheck({ cwd: dir, today: TODAY, listFiles: () => Promise.resolve([]) }, [
        declarationLayer,
        pythonSettingsLayer,
      ]);
      return r.findings.filter((f) => /mypy|coverage/.test(f.message)).map((f) => `${f.level}:${f.message}`);
    };
    expect(await on("team@1.1.0")).toEqual([
      expect.stringMatching(/^error:.*mypy strict/),
      expect.stringMatching(/^error:coverage 沒有開啟/),
    ]);
    expect(await on("legacy@1.0.0")).toEqual([]);
  });

  it("needs no coverage settings at all, since no coverage total can fail", async () => {
    expect(await errors("legacy@1.0.0", { "vitest.config.ts": undefined })).toEqual([]);
    const noInclude = { "vitest.config.ts": "export default { test: { coverage: {} } };\n" };
    expect(await errors("legacy@1.0.0", noInclude)).toEqual([]);
  });
});
