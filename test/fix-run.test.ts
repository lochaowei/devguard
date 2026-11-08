import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIX_LAYERS, runCheck } from "../src/check.ts";
import { runFix } from "../src/fix/run.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import type { Finding } from "../src/report/finding.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-fixrun-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

const YES: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

const fixable = (f: Finding) => f.fix?.startsWith("devguard fix") === true;

async function check(dir: string): Promise<Finding[]> {
  return (await runCheck({ cwd: dir, today: TODAY }, FIX_LAYERS)).findings;
}

/** Fixable findings before, none after `fix --yes`. Returns the findings after. */
async function fixesEverything(dir: string): Promise<Finding[]> {
  const before = (await check(dir)).filter(fixable);
  expect(before.length).toBeGreaterThan(0);
  expect(await runFix({ cwd: dir, today: TODAY, io: YES })).toBe(0);
  const after = await check(dir);
  expect(after.filter(fixable)).toEqual([]);
  return after;
}

const decl = (language: string) => `standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: ${language}\n`;

describe("devguard fix --yes: fixable findings disappear (SPEC §9)", () => {
  it("Python: edits pyproject.toml [tool.*] and keeps comments, blank lines and order", async () => {
    const pyproject = `# app
[project]
name = "app"
requires-python = ">=3.11"

[tool.ruff]
line-length = 100 # narrow
extend-select = ["B"]

[[tool.uv.index]]
name = "nexus"
url = "https://nexus.example.internal/repository/pypi-proxy/simple"
default = true
`;
    const dir = repo({ ".devguard.yaml": decl("python"), "pyproject.toml": pyproject });
    await fixesEverything(dir);
    const out = read(dir, "pyproject.toml");
    expect(
      out.startsWith(
        '# app\n[project]\nname = "app"\nrequires-python = ">=3.11"\n\n[tool.ruff]\nline-length = 120 # narrow\n',
      ),
    ).toBe(true);
    expect(out).toContain('[[tool.uv.index]]\nname = "nexus"');
  });

  it("Python: creates pyproject.toml when it is missing", async () => {
    const dir = repo({ ".devguard.yaml": decl("python") });
    await fixesEverything(dir);
  });

  it("Go: edits .golangci.yml keeping its comments", async () => {
    const golangci =
      '# team lint\nversion: "2"\nlinters:\n  enable: [gosec] # more below\n  disable: [cyclop]\n  settings:\n    cyclop:\n      max-complexity: 20\n';
    const dir = repo({ ".devguard.yaml": decl("go"), ".golangci.yml": golangci, "go.mod": "module x\n\ngo 1.26\n" });
    await fixesEverything(dir);
    const out = read(dir, ".golangci.yml");
    expect(out).toContain("# team lint");
    expect(out).toContain("# more below");
    expect(out).toContain("max-complexity: 10");
  });

  it("Go: creates .golangci.yml when it is missing", async () => {
    const dir = repo({ ".devguard.yaml": decl("go"), "go.mod": "module x\n\ngo 1.26\n" });
    await fixesEverything(dir);
  });

  it("TypeScript: edits tsconfig.json, .prettierrc and package.json jest, prints the code-form configs", async () => {
    const dir = repo({
      ".devguard.yaml": decl("typescript") + "    overrides:\n      test.tool: jest\n",
      "tsconfig.json": '{\n  // project options\n  "compilerOptions": { "strict": false, "target": "es2022" }\n}\n',
      ".prettierrc": "printWidth: 80 # old\n",
      "package.json": '{\n  "name": "web",\n  "jest": { "coverageThreshold": { "global": { "lines": 50 } } }\n}\n',
      "eslint.config.js":
        'export default [tseslint.configs.strictTypeChecked, { rules: { complexity: ["error", 30] } }];\n',
    });
    const eslint = read(dir, "eslint.config.js");
    const after = await fixesEverything(dir);
    expect(read(dir, "tsconfig.json")).toContain("// project options");
    expect(read(dir, ".prettierrc")).toContain("printWidth: 120 # old");
    expect(read(dir, "eslint.config.js")).toBe(eslint);
    expect(after.some((f) => f.file === "eslint.config.js" && f.level === "error")).toBe(true);
  });

  it("TypeScript: edits biome.json", async () => {
    const dir = repo({
      ".devguard.yaml": decl("typescript") + "    overrides:\n      lint.tool: biome\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          noImplicitOverride: true,
          noFallthroughCasesInSwitch: true,
        },
      }),
      "biome.json": '{ "formatter": { "lineWidth": 80 }, "linter": { "enabled": false } }\n',
    });
    await fixesEverything(dir);
  });

  it("Java: regenerates checkstyle.xml and the PMD ruleset, never touches pom.xml", async () => {
    const pom = `<project><properties><maven.compiler.release>11</maven.compiler.release></properties></project>\n`;
    const dir = repo({
      ".devguard.yaml": decl("java"),
      "pom.xml": pom,
      mvnw: "",
      "mvnw.cmd": "",
      "checkstyle.xml": '<!-- 由 CLI 產生（devguard） -->\n<module name="Checker"><module name="TreeWalker"/></module>',
    });
    const after = await fixesEverything(dir);
    expect(read(dir, "checkstyle.xml")).toContain('<module name="CyclomaticComplexity">');
    expect(read(dir, "pmd-ruleset.xml")).toContain("由 CLI 產生");
    expect(read(dir, "pom.xml")).toBe(pom);
    expect(after.map((f) => f.rule)).toContain("settings/looser");
  });

  it("Java: never overwrites a checkstyle.xml or PMD ruleset devguard did not generate, prints what to add (#100)", async () => {
    const checkstyle = [
      '<?xml version="1.0"?>',
      '<module name="Checker">',
      "  <!-- the team's own checks -->",
      '  <module name="TreeWalker">',
      '    <module name="FinalLocalVariable"/>',
      '    <module name="MagicNumber"/>',
      "  </module>",
      "</module>",
      "",
    ].join("\n");
    const pmd =
      '<?xml version="1.0"?>\n<ruleset name="ours">\n  <rule ref="rulesets/java/quickstart.xml"/>\n</ruleset>\n';
    const dir = repo({
      ".devguard.yaml": decl("java"),
      "pom.xml": "<project/>\n",
      mvnw: "",
      "mvnw.cmd": "",
      "checkstyle.xml": checkstyle,
      "pmd-ruleset.xml": pmd,
    });
    const own = (f: Finding) => f.file === "checkstyle.xml" || f.file === "pmd-ruleset.xml";
    const before = (await check(dir)).filter(own);
    expect(before.map((f) => f.rule).sort()).toEqual([
      "settings/checkstyle-module-missing",
      "settings/checkstyle-module-missing",
      "settings/pmd-rule-missing",
    ]);
    expect(before.filter(fixable)).toEqual([]);
    expect(before[0]?.fix).toContain("不是 devguard 產生的");
    let out = "";
    const io: Interaction = { ...YES, write: (s) => (out += s) };
    await runFix({ cwd: dir, today: TODAY, io });
    expect(read(dir, "checkstyle.xml")).toBe(checkstyle);
    expect(read(dir, "pmd-ruleset.xml")).toBe(pmd);
    expect(out).toContain("checkstyle.xml：這份檔案不是 devguard 產生的，不會覆寫");
    expect(out).toContain(
      '    <module name="CyclomaticComplexity">\n      <property name="max" value="10"/>\n    </module>',
    );
    expect(out).toContain('    <module name="IllegalImport">');
    expect(out).toContain('    <rule ref="category/java/design.xml/CognitiveComplexity">');
    expect(out).not.toContain("<!DOCTYPE");
  });

  it("adds * text=auto eol=lf to .gitattributes", async () => {
    const dir = repo({ ".devguard.yaml": decl("python"), ".gitattributes": "*.png binary\n" });
    await fixesEverything(dir);
    expect(read(dir, ".gitattributes")).toBe("*.png binary\n* text=auto eol=lf\n");
  });

  it("without --yes in a non-interactive run, previews only and exits 1", async () => {
    const dir = repo({ ".devguard.yaml": decl("python"), ".gitattributes": "" });
    const out: string[] = [];
    const io: Interaction = { ...YES, yes: false, write: (t) => out.push(t) };
    expect(await runFix({ cwd: dir, today: TODAY, io })).toBe(1);
    expect(out.join("")).toContain("+* text=auto eol=lf");
    expect(read(dir, ".gitattributes")).toBe("");
  });

  it("reports declaration error and exits 1 when .devguard.yaml is missing", async () => {
    const dir = repo({});
    const out: string[] = [];
    const io: Interaction = { ...YES, write: (t) => out.push(t) };
    expect(await runFix({ cwd: dir, today: TODAY, io })).toBe(1);
    expect(out.join("")).toContain("declaration/missing");
  });

  it("TypeScript: creates tsconfig.json, .prettierrc and biome.json when they are missing", async () => {
    const tsDir = repo({ ".devguard.yaml": decl("typescript") });
    await fixesEverything(tsDir);
    expect(read(tsDir, "tsconfig.json")).toContain('"strict": true');
    expect(read(tsDir, ".prettierrc")).toContain('"printWidth": 120');

    const biomeDir = repo({
      ".devguard.yaml": decl("typescript") + "    overrides:\n      lint.tool: biome\n",
    });
    await fixesEverything(biomeDir);
    expect(read(biomeDir, "biome.json")).toContain('"lineWidth": 120');
  });
});
