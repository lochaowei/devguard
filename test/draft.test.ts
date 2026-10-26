import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DeclarationExistsError, draftDeclaration, writeDraft } from "../src/draft.ts";
import { GO_CLEAN_FILES, TODAY } from "./helpers.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp project with the given files (repo-relative path → content). */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-draft-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

interface DraftYaml {
  standard: string;
  components: { path: string; language: string; overrides?: Record<string, unknown> }[];
}

async function draft(files: Record<string, string>): Promise<DraftYaml> {
  const cwd = project(files);
  const { text } = await draftDeclaration({ cwd, today: TODAY, files: Object.keys(files) });
  return parse(text) as DraftYaml;
}

describe("draftDeclaration: components", () => {
  it("infers one component per directory and language in a monorepo", async () => {
    const d = await draft({
      "pyproject.toml": "[project]\nname = 'app'\n",
      "app/main.py": "",
      "backend/go.mod": "module x\n\ngo 1.26\n",
      "backend/cmd/main.go": "",
      "web/package.json": "{}",
      "web/src/app.ts": "",
      "README.md": "",
    });
    expect(d.standard).toBe("team@1.1.0");
    expect(d.components.map((c) => [c.path, c.language])).toEqual([
      ["./", "python"],
      ["backend/", "go"],
      ["web/", "typescript"],
    ]);
  });
});

const TS_OPTIONS = ["strict", "noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"];

/** A TypeScript component in web/ with the given ESLint complexity limit and Vitest coverage threshold. */
function tsComponent(complexity: number, coverage: number): Record<string, string> {
  const thresholds = ["lines", "branches", "functions", "statements"].map((k) => `${k}: ${String(coverage)}`);
  return {
    "web/package.json": "{}",
    "web/src/app.ts": "",
    "web/tsconfig.json": JSON.stringify({ compilerOptions: Object.fromEntries(TS_OPTIONS.map((o) => [o, true])) }),
    "web/.prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
    "web/eslint.config.js": `export default [tseslint.configs.strictTypeChecked, { rules: { complexity: ["error", ${String(complexity)}], "sonarjs/cognitive-complexity": ["error", 15] } }];`,
    "web/vitest.config.ts": `export default { test: { coverage: { thresholds: { ${thresholds.join(", ")} } } } };`,
  };
}

describe("draftDeclaration: overrides from tool settings", () => {
  it("leaves out values that match the default", async () => {
    const d = await draft(tsComponent(10, 80));
    expect(d.components).toEqual([{ path: "web/", language: "typescript" }]);
  });

  it("writes a looser value with a TODO reason and a stricter value as is", async () => {
    const d = await draft(tsComponent(8, 60));
    const overrides = d.components[0]?.overrides;
    expect(overrides?.["complexity.cyclomatic"]).toBe(8);
    expect(overrides?.["coverage.lines"]).toEqual({
      value: 60,
      reason: expect.stringMatching(/^TODO.*web\/vitest\.config\.ts/) as unknown,
    });
  });
});

describe("writeDraft", () => {
  it("writes .devguard.yaml with a header saying it is a draft", async () => {
    const cwd = project(tsComponent(10, 60));
    const r = await writeDraft({
      cwd,
      today: TODAY,
      listFiles: () => Promise.resolve(Object.keys(tsComponent(10, 60))),
    });
    const text = readFileSync(join(cwd, ".devguard.yaml"), "utf8");
    expect(r.path).toBe(join(cwd, ".devguard.yaml"));
    expect(text.startsWith("# ")).toBe(true);
    expect((parse(text) as DraftYaml).components[0]?.overrides).toHaveProperty("coverage.lines");
  });

  it("refuses to overwrite an existing declaration", async () => {
    const cwd = project({ ".devguard.yaml": "keep me\n", "a.py": "" });
    await expect(writeDraft({ cwd, today: TODAY })).rejects.toBeInstanceOf(DeclarationExistsError);
    expect(readFileSync(join(cwd, ".devguard.yaml"), "utf8")).toBe("keep me\n");
  });
});

describe("draftDeclaration: other languages", () => {
  it("reads Python settings from pyproject.toml", async () => {
    const pyproject = [
      "[project]",
      'requires-python = ">=3.11"',
      "[tool.ruff]",
      "line-length = 100",
      'target-version = "py311"',
      "[tool.ruff.lint]",
      'select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]',
      "[tool.ruff.lint.mccabe]",
      "max-complexity = 12",
      "[tool.mypy]",
      "strict = true",
      "",
    ].join("\n");
    const d = await draft({ "pyproject.toml": pyproject, "app/main.py": "" });
    expect(d.components[0]?.overrides).toEqual({
      "complexity.cyclomatic": { value: 12, reason: expect.stringMatching(/^TODO.*pyproject\.toml/) as unknown },
      "format.lineLength": 100,
    });
  });

  it("reads Go settings from .golangci.yml and go.mod", async () => {
    const golangci = (GO_CLEAN_FILES[".golangci.yml"] ?? "")
      .replace("max-complexity: 10", "max-complexity: 20")
      .replace("min-complexity: 15", "min-complexity: 12");
    const d = await draft({ "svc/.golangci.yml": golangci, "svc/go.mod": "module x\n\ngo 1.25\n", "svc/main.go": "" });
    expect(d.components[0]?.overrides).toEqual({
      "complexity.cyclomatic": { value: 20, reason: expect.stringMatching(/^TODO.*svc\/\.golangci\.yml/) as unknown },
      "complexity.cognitive": 12,
      "go.minVersion": { value: "1.25", reason: expect.stringMatching(/^TODO.*svc\/go\.mod/) as unknown },
    });
  });

  it("reads the Java version from pom.xml and treats nested modules as one component", async () => {
    const pom = "<project><properties><maven.compiler.release>11</maven.compiler.release></properties></project>";
    const d = await draft({ "pom.xml": pom, "core/pom.xml": "<project/>", "core/src/main/java/App.java": "" });
    expect(d.components).toHaveLength(1);
    expect(d.components[0]?.path).toBe("./");
    expect(d.components[0]?.overrides?.["java.minVersion"]).toEqual({
      value: "11",
      reason: expect.stringMatching(/^TODO/) as unknown,
    });
  });

  it("infers non-default tool choices from Gradle, pnpm, yarn, poetry, Biome, Jest, and Pyright files", async () => {
    const d = await draft({
      "gradle-app/build.gradle.kts": "",
      "gradle-app/src/main/java/App.java": "",
      "pnpm-web/package.json": "{}",
      "pnpm-web/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-web/biome.json": '{ "formatter": { "lineWidth": 100 } }',
      "pnpm-web/jest.config.js": "module.exports = {};",
      "pnpm-web/src/index.ts": "",
      "yarn-web/package.json": "{}",
      "yarn-web/yarn.lock": "",
      "yarn-web/src/index.ts": "",
      "py-svc/pyproject.toml": "[project]\nname = 'svc'\n",
      "py-svc/poetry.lock": "",
      "py-svc/pyrightconfig.json": '{ "typeCheckingMode": "basic" }',
      "py-svc/app.py": "",
    });
    const byPath = Object.fromEntries(d.components.map((c) => [c.path, c.overrides]));
    expect(byPath["gradle-app/"]).toEqual({ "build.tool": "gradle" });
    expect(byPath["pnpm-web/"]).toMatchObject({
      "deps.manager": "pnpm",
      "lint.tool": "biome",
      "test.tool": "jest",
      "format.printWidth": 100,
    });
    expect(byPath["yarn-web/"]).toEqual({ "deps.manager": "yarn" });
    expect(byPath["py-svc/"]).toMatchObject({
      "deps.manager": "poetry",
      "typecheck.tool": "pyright",
    });
  });
});
