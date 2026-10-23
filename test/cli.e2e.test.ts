import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The one true end-to-end case: `node src/cli.ts` against a TypeScript project that borrows this repo's
 * node_modules, so the real ESLint, Prettier and tsc run. Everything else about the CLI is tested in-process
 * (test/cli.test.ts).
 */
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "devguard-e2e-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spawn = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const ESLINT_CONFIG = `import tseslint from "typescript-eslint";

// A stand-in for eslint-plugin-sonarjs, which this sample does not install.
const sonarjs = { rules: { "cognitive-complexity": { meta: { schema: false }, create: () => ({}) } } };

export default tseslint.config({ ignores: ["eslint.config.js"] }, tseslint.configs.strictTypeChecked, {
  languageOptions: { parserOptions: { projectService: true } },
  plugins: { sonarjs },
  rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] },
});
`;

/** A TypeScript project that meets team@1.0.0 except for a.ts, which ESLint and Prettier can fix. */
function messyProject(): void {
  const tsOptions = ["strict", "noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"];
  const compilerOptions = { ...Object.fromEntries(tsOptions.map((o) => [o, true])), types: [] };
  const thresholds = "lines: 80, branches: 80, functions: 80, statements: 80";
  const files: Record<string, string> = {
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - { path: ./, language: typescript }\n",
    // Satisfies the deps layer; the temp dir is not a git repo, so existing counts as committed.
    "package-lock.json": "{}\n",
    ".gitattributes": "* text=auto eol=lf\n",
    "tsconfig.json": `${JSON.stringify({ compilerOptions }, null, 2)}\n`,
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
    ".npmrc": "registry=https://nexus.example.internal/repository/npm-proxy/\n",
    "eslint.config.js": ESLINT_CONFIG,
    "vitest.config.ts": `export default { test: { coverage: { thresholds: { ${thresholds} } } } };\n`,
    "a.ts": "let  answer = 42;\nexport { answer };\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
}

describe("devguard fix --code end to end, with the real tools", { timeout: 120_000 }, () => {
  it("fixes the given file with --yes, after which check passes", () => {
    messyProject();
    const r = spawn(["fix", "--code", "--yes", "--cwd", dir, join(dir, "a.ts")]);
    expect(r.out).toContain("通過");
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const answer = 42;\nexport { answer };\n");
    expect(spawn(["check", "--cwd", dir]).code).toBe(0);
  });
});
