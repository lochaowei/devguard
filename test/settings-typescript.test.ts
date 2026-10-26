import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { typescriptSettingsLayer } from "../src/layers/settings-typescript.ts";
import type { Finding } from "../src/report/finding.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DECL = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n";

const STRICT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
  },
});

const ESLINT = `import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
export default [
  tseslint.configs.strictTypeChecked,
  { plugins: { sonarjs }, rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] } },
];
`;

const VITEST = `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    coverage: { include: ["src/**/*.ts"], thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 } },
  },
});
`;

/** A TypeScript project that meets team@1.0.0; `files` replaces or adds files (undefined removes one). */
function project(files: Record<string, string | undefined> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-ts-"));
  dirs.push(dir);
  const all: Record<string, string | undefined> = {
    ".devguard.yaml": DECL,
    "tsconfig.json": STRICT_TSCONFIG,
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
    "eslint.config.js": ESLINT,
    "vitest.config.ts": VITEST,
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    if (text === undefined) continue;
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

async function check(dir: string): Promise<Finding[]> {
  const r = await runCheck({ cwd: dir, today: TODAY, listFiles: () => Promise.resolve([]) }, [
    declarationLayer,
    typescriptSettingsLayer,
  ]);
  return r.findings;
}

const summary = (fs: Finding[]) => fs.map((f) => `${f.level}:${f.rule}:${f.file ?? ""}`);

describe("TypeScript settings check: tsconfig", () => {
  it("passes a project that meets the standard", async () => {
    expect(await check(project())).toEqual([]);
  });

  it("reports an error when strict is missing", async () => {
    const fs = await check(project({ "tsconfig.json": '{ "compilerOptions": { "noUncheckedIndexedAccess": true } }' }));
    expect(summary(fs)).toContain("error:settings/looser:tsconfig.json");
    expect(fs.map((f) => f.message).join("\n")).toMatch(/strict/);
    expect(fs.map((f) => f.message).join("\n")).toMatch(/noImplicitOverride/);
  });
});

describe("TypeScript settings check: tsconfig extends", () => {
  it("follows a relative extends and reads JSONC", async () => {
    const dir = project({
      "tsconfig.json": '{\n  // base has the checks\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": {},\n}',
      "tsconfig.base.json": STRICT_TSCONFIG,
    });
    expect(await check(dir)).toEqual([]);
  });

  it("follows a package extends from an ancestor node_modules and chained extends", async () => {
    const dir = project({
      ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: packages/web/\n    language: typescript\n",
      "node_modules/@company/tsconfig/base.json": STRICT_TSCONFIG,
      "node_modules/@company/tsconfig/tsconfig.json": '{ "extends": "./base.json" }',
      "packages/web/tsconfig.json": '{ "extends": "@company/tsconfig" }',
      "packages/web/.prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
      "packages/web/eslint.config.js": ESLINT,
      "packages/web/vitest.config.ts": VITEST,
    });
    expect(await check(dir)).toEqual([]);
  });

  it("only hints when a base cannot be read, since it may set the options", async () => {
    const dir = project({
      "tsconfig.json": '{ "extends": "@company/tsconfig", "compilerOptions": { "strict": true } }',
    });
    const fs = await check(dir);
    expect(new Set(summary(fs))).toEqual(new Set(["hint:settings/unconfirmed:tsconfig.json"]));
    expect(fs).toHaveLength(3);
  });

  it("reports a missing tsconfig.json", async () => {
    expect(summary(await check(project({ "tsconfig.json": undefined })))).toEqual([
      "error:settings/missing-file:tsconfig.json",
    ]);
  });

  it("hints when tsconfig is stricter than a relaxed declaration", async () => {
    const decl =
      DECL + '    overrides:\n      typecheck.strict: {value: false, reason: "migrating", until: 2099-01-01}\n';
    expect(summary(await check(project({ ".devguard.yaml": decl })))).toEqual([
      "deviation:declaration/deviation:.devguard.yaml",
      "hint:settings/stricter:tsconfig.json",
    ]);
  });
});

const eslint = (rules: string, preset = "tseslint.configs.strictTypeChecked") =>
  `import tseslint from "typescript-eslint";\nexport default [\n  ${preset},\n  { rules: { ${rules} } },\n];\n`;

describe("TypeScript settings check: ESLint", () => {
  it("reports a complexity limit looser than declared, hints at a stricter one", async () => {
    const looser = eslint(`complexity: ["error", 20], "sonarjs/cognitive-complexity": ["error", 15]`);
    expect(summary(await check(project({ "eslint.config.js": looser })))).toEqual([
      "error:settings/looser:eslint.config.js",
    ]);
    const stricter = eslint(`complexity: ["error", { max: 8 }], "sonarjs/cognitive-complexity": ["error", 12]`);
    expect(summary(await check(project({ "eslint.config.js": stricter })))).toEqual([
      "hint:settings/stricter:eslint.config.js",
      "hint:settings/stricter:eslint.config.js",
    ]);
  });

  it("treats a rule turned off, or on without a limit, by ESLint's semantics", async () => {
    const off = eslint(`"complexity": "off", "sonarjs/cognitive-complexity": 2`);
    const fs = await check(project({ "eslint.config.mjs": off, "eslint.config.js": undefined }));
    expect(summary(fs)).toEqual(["error:settings/looser:eslint.config.mjs"]);
    const noMax = eslint(`complexity: "error", "sonarjs/cognitive-complexity": "error"`);
    expect(summary(await check(project({ "eslint.config.js": noMax })))).toEqual([
      "error:settings/looser:eslint.config.js",
    ]);
  });

  it("reports a weaker typescript-eslint preset", async () => {
    const weak = eslint(
      `complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15]`,
      "tseslint.configs.recommendedTypeChecked",
    );
    const fs = await check(project({ "eslint.config.js": weak }));
    expect(summary(fs)).toEqual(["error:settings/looser:eslint.config.js"]);
    expect(fs[0]?.message).toMatch(/strictTypeChecked/);
  });

  it("only hints about what a code-form config does not show literally", async () => {
    const indirect = `import shared from "@company/eslint-config";\nexport default [...shared, { rules: { complexity: ["error", max] } }];\n`;
    const fs = await check(project({ "eslint.config.js": indirect }));
    expect(summary(fs)).toEqual([
      "hint:settings/unconfirmed:eslint.config.js",
      "hint:settings/unconfirmed:eslint.config.js",
      "hint:settings/unconfirmed:eslint.config.js",
    ]);
  });

  it("reports a missing flat config", async () => {
    const fs = await check(project({ "eslint.config.js": undefined, ".eslintrc.json": "{}" }));
    expect(summary(fs)).toEqual(["error:settings/missing-file:eslint.config.js"]);
  });
});

const vitest = (thresholds: string) =>
  `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { coverage: { include: ["src/**"], thresholds: { ${thresholds} } } } });\n`;

describe("TypeScript settings check: coverage thresholds", () => {
  it("reports thresholds below the declaration and hints at ones above it", async () => {
    const fs = await check(project({ "vitest.config.ts": vitest("lines: 70, branches: 90, functions: 80") }));
    expect(fs.map((f) => `${f.level}:${f.rule}:${f.message}`)).toEqual([
      "error:settings/looser:Vitest coverage.thresholds.lines 為 70，比宣告的 80 寬鬆",
      "hint:settings/stricter:Vitest coverage.thresholds.branches 為 90，比宣告的 80 嚴格",
      "error:settings/looser:Vitest coverage.thresholds.statements 沒有啟用",
    ]);
  });

  it("follows a relaxed declaration", async () => {
    const decl = DECL + '    overrides:\n      coverage.lines: {value: 70, reason: "legacy", until: 2099-01-01}\n';
    const dir = project({
      ".devguard.yaml": decl,
      "vitest.config.ts": vitest("lines: 70, branches: 70, functions: 70, statements: 70"),
    });
    expect(summary(await check(dir))).toEqual(["deviation:declaration/deviation:.devguard.yaml"]);
  });

  it("reads `100: true` as every threshold at 100", async () => {
    expect(summary(await check(project({ "vitest.config.ts": vitest("100: true") })))).toEqual(
      Array(4).fill("hint:settings/stricter:vitest.config.ts"),
    );
  });

  it("hints instead of guessing when thresholds come from elsewhere", async () => {
    const shared = `import base from "./base";\nexport default mergeConfig(base, { test: {} });\n`;
    expect(summary(await check(project({ "vitest.config.ts": shared })))).toEqual([
      "hint:settings/unconfirmed:vitest.config.ts",
    ]);
    const noThresholds = `export default { test: { coverage: { provider: "v8", include: ["src/**"] } } };\n`;
    expect(summary(await check(project({ "vitest.config.ts": noThresholds })))).toEqual([
      "error:settings/looser:vitest.config.ts",
    ]);
  });

  it("reports a missing Vitest config", async () => {
    expect(summary(await check(project({ "vitest.config.ts": undefined })))).toEqual([
      "error:settings/missing-file:vitest.config.ts",
    ]);
  });

  it("checks coverageThreshold.global when the test tool is Jest", async () => {
    const decl = DECL + "    overrides:\n      test.tool: jest\n";
    const jest = `module.exports = { collectCoverageFrom: ["src/**"], coverageThreshold: { global: { lines: 80, branches: 60, functions: 80, statements: -10 } } };\n`;
    const fs = await check(project({ ".devguard.yaml": decl, "vitest.config.ts": undefined, "jest.config.js": jest }));
    expect(summary(fs)).toEqual(["error:settings/looser:jest.config.js", "hint:settings/unconfirmed:jest.config.js"]);
    const pkg = JSON.stringify({
      jest: {
        collectCoverageFrom: ["src/**"],
        coverageThreshold: { global: { lines: 80, branches: 80, functions: 80, statements: 80 } },
      },
    });
    expect(
      await check(project({ ".devguard.yaml": decl, "vitest.config.ts": undefined, "package.json": pkg })),
    ).toEqual([]);
    expect(summary(await check(project({ ".devguard.yaml": decl, "vitest.config.ts": undefined })))).toEqual([
      "error:settings/missing-file:jest.config.js",
    ]);
  });
});

describe("TypeScript settings check: which files coverage counts (#45)", () => {
  const scope = (fs: Finding[]) => fs.filter((f) => f.rule === "settings/coverage-include");
  const thresholds = "thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 }";

  it("reports a Vitest config without coverage.include, printing the setting to add", async () => {
    const noInclude = `export default { test: { coverage: { ${thresholds} } } };\n`;
    const [f, ...rest] = scope(await check(project({ "vitest.config.ts": noInclude })));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ level: "error", file: "vitest.config.ts" });
    expect(f?.message).toMatch(/^Vitest coverage\.include 沒有設定/);
    expect(f?.fix).toContain("devguard fix 會印出要套用的片段");
  });

  it("reports a Jest config without collectCoverageFrom", async () => {
    const decl = DECL + "    overrides:\n      test.tool: jest\n";
    const jest = `module.exports = { coverageThreshold: { global: { lines: 80, branches: 80, functions: 80, statements: 80 } } };\n`;
    const fs = await check(project({ ".devguard.yaml": decl, "vitest.config.ts": undefined, "jest.config.js": jest }));
    expect(scope(fs).map((f) => f.file)).toEqual(["jest.config.js"]);
    expect(scope(fs)[0]?.message).toMatch(/^Jest collectCoverageFrom 沒有設定/);
  });

  it("leaves a config that pulls its settings from elsewhere alone", async () => {
    const shared = `import base from "./base";\nexport default mergeConfig(base, { test: { coverage: {} } });\n`;
    expect(scope(await check(project({ "vitest.config.ts": shared })))).toEqual([]);
  });
});

describe("TypeScript settings check: Biome", () => {
  const decl = DECL + "    overrides:\n      lint.tool: biome\n";
  const biome = (extra = "") => `{
  // Biome replaces ESLint and Prettier
  "formatter": { "lineWidth": 120 },
  "linter": { "rules": { "complexity": { "noExcessiveCognitiveComplexity": "error" } } },${extra}
}`;

  it("checks biome.json instead of ESLint and Prettier", async () => {
    const dir = project({
      ".devguard.yaml": decl,
      "eslint.config.js": undefined,
      ".prettierrc": undefined,
      "biome.jsonc": biome(),
    });
    expect(await check(dir)).toEqual([]);
  });

  it("reports a narrower line width, CRLF and a missing cognitive complexity rule", async () => {
    const text = `{
  "formatter": { "lineWidth": 120, "lineEnding": "crlf" },
  "javascript": { "formatter": { "lineWidth": 100 } },
  "linter": { "rules": { "complexity": { "noExcessiveCognitiveComplexity": { "level": "error", "options": { "maxAllowedComplexity": 20 } } } } }
}`;
    const fs = await check(project({ ".devguard.yaml": decl, "biome.json": text }));
    expect(summary(fs)).toEqual(Array(3).fill("error:settings/looser:biome.json"));
    const off = `{ "formatter": { "lineWidth": 120 } }`;
    expect(summary(await check(project({ ".devguard.yaml": decl, "biome.json": off })))).toEqual([
      "error:settings/looser:biome.json",
    ]);
  });

  it("hints when biome extends another config that may set what is missing", async () => {
    const text = `{ "extends": ["@company/biome"] }`;
    expect(summary(await check(project({ ".devguard.yaml": decl, "biome.json": text })))).toEqual(
      Array(3).fill("hint:settings/unconfirmed:biome.json"),
    );
  });

  it("reports a missing biome.json", async () => {
    expect(summary(await check(project({ ".devguard.yaml": decl })))).toEqual([
      "error:settings/missing-file:biome.json",
    ]);
  });
});

describe("TypeScript settings check: Prettier", () => {
  it("reports printWidth and endOfLine that differ from the declaration", async () => {
    const fs = await check(project({ ".prettierrc": '{ "printWidth": 100, "endOfLine": "crlf" }' }));
    expect(summary(fs)).toEqual(["error:settings/looser:.prettierrc", "error:settings/looser:.prettierrc"]);
  });

  it("judges style items by the declared value", async () => {
    const decl = DECL + "    overrides:\n      format.printWidth: 100\n";
    const dir = project({
      ".devguard.yaml": decl,
      ".prettierrc.yaml": "printWidth: 100\nendOfLine: lf\n",
      ".prettierrc": undefined,
    });
    expect(await check(dir)).toEqual([]);
  });

  it("uses Prettier's defaults when there is no config", async () => {
    const fs = await check(project({ ".prettierrc": undefined }));
    expect(summary(fs)).toEqual(["error:settings/missing-file:.prettierrc"]);
  });

  it("reads the prettier key of package.json", async () => {
    const dir = project({ ".prettierrc": undefined, "package.json": '{ "prettier": { "printWidth": 120 } }' });
    expect(await check(dir)).toEqual([]);
  });

  it("reads literals from a code-form config and hints about what it cannot see", async () => {
    const dir = project({
      ".prettierrc": undefined,
      "prettier.config.js": "export default { ...shared, printWidth: 120 };",
    });
    expect(summary(await check(dir))).toEqual(["hint:settings/unconfirmed:prettier.config.js"]);
  });
});
