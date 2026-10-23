import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDate } from "../src/check.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const dirs: string[] = [];

function project(declaration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  if (declaration !== undefined) writeFileSync(join(dir, ".devguard.yaml"), declaration);
  // Satisfies the deps layer for npm components; the temp dir is not a git repo, so existing counts as committed.
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  return dir;
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEVIATING = [
  "standard: team@1.0.0",
  "components:",
  "  - path: web/",
  "    language: typescript",
  "    overrides:",
  '      coverage.lines: {value: 60, reason: "legacy", until: 2099-01-01}',
  "",
].join("\n");

const ESLINT_CONFIG = `import tseslint from "typescript-eslint";

// A stand-in for eslint-plugin-sonarjs, which this sample does not install.
const sonarjs = { rules: { "cognitive-complexity": { meta: { schema: false }, create: () => ({}) } } };

export default tseslint.config({ ignores: ["eslint.config.js"] }, tseslint.configs.strictTypeChecked, {
  languageOptions: { parserOptions: { projectService: true } },
  plugins: { sonarjs },
  rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] },
});
`;

/**
 * Writes TypeScript tool configs that meet team@1.0.0, with the given coverage threshold. The configs are clean
 * under the real ESLint, Prettier and tsc, which run from this repo's node_modules (linked in).
 */
function writeTsConfigs(dir: string, coverage: number): void {
  const tsOptions = ["strict", "noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"];
  const thresholds = ["lines", "branches", "functions", "statements"]
    .map((k) => `${k}: ${String(coverage)}`)
    .join(", ");
  const compilerOptions = { ...Object.fromEntries(tsOptions.map((o) => [o, true])), types: [] };
  const files: Record<string, string> = {
    "tsconfig.json": `${JSON.stringify({ compilerOptions }, null, 2)}\n`,
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
    "eslint.config.js": ESLINT_CONFIG,
    "vitest.config.ts": `export default { test: { coverage: { thresholds: { ${thresholds} } } } };\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
}

/** DEVIATING plus web/ tool configs that match it, so the deviation is the only finding. */
function deviatingProject(): string {
  const dir = project(DEVIATING);
  const web = join(dir, "web");
  mkdirSync(web);
  writeTsConfigs(web, 60);
  return dir;
}

describe("devguard check", { timeout: 60_000 }, () => {
  it("exits 0 for a clean declaration", () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - { path: ./, language: typescript }\n");
    writeTsConfigs(dir, 80);
    const r = run(["check", "--cwd", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("通過");
  });

  it("exits 0 with deviations, 1 with --strict", () => {
    const dir = deviatingProject();
    expect(run(["check", "--cwd", dir]).code).toBe(0);
    expect(run(["check", "--cwd", dir, "--strict"]).code).toBe(1);
  });

  it("exits 1 when the declaration is missing", () => {
    const r = run(["check", "--cwd", project()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("找不到 .devguard.yaml");
  });

  it("exits 1 on a YAML syntax error", () => {
    expect(run(["check", "--cwd", project("standard: [\n")]).code).toBe(1);
  });

  it("prints JSON with --format json", () => {
    const r = run(["check", "--cwd", deviatingProject(), "--format", "json"]);
    const json = JSON.parse(r.out) as { standard: string; findings: { level: string }[] };
    expect(json.standard).toBe("team@1.0.0");
    expect(json.findings.map((x) => x.level)).toEqual(["deviation"]);
  });

  it("prints sarif, vscode and claude formats with the same exit code as text", () => {
    const dir = project();
    const out = (format: string) => {
      const r = run(["check", "--cwd", dir, "--format", format]);
      expect(r.code).toBe(1);
      return r.out;
    };
    expect(out("vscode")).toMatch(/^\.devguard\.yaml:1:1: error: 找不到 \.devguard\.yaml.* \[[^\]]+\]$/m);
    expect(out("claude")).toMatch(/^devguard：1 個錯誤.*\n- 錯誤 .*找不到 \.devguard\.yaml/);
    // The missing declaration is not a code finding, so SARIF has no results.
    const sarif = JSON.parse(out("sarif")) as { version: string; runs: { results: unknown[] }[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(run(["check", "--cwd", deviatingProject(), "--format", "vscode", "--strict"]).code).toBe(1);
  });

  it("exits 2 on usage errors", () => {
    expect(run(["frobnicate"]).code).toBe(2);
    expect(run(["check", "--format", "xml"]).code).toBe(2);
    expect(run(["check", "--nope"]).code).toBe(2);
    expect(run([]).code).toBe(2);
  });

  it("rejects an unknown --only category and --full together with files", () => {
    const dir = project("standard: team@1.0.0\ncomponents: []\n");
    const bad = run(["check", "--cwd", dir, "--only", "speling"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("lint|format|typecheck");
    expect(run(["check", "--cwd", dir, "--full", join(dir, "a.ts")]).code).toBe(2);
    expect(run(["check", "--cwd", dir, join(tmpdir(), "elsewhere.ts")]).code).toBe(2);
  });

  it("exits 2 with `npm ci` when the TypeScript tools are not installed", () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - {path: ./, language: typescript}\n");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const r = run(["check", "--cwd", dir, "--only", "lint", join(dir, "a.ts")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("eslint");
    expect(r.err).toContain("npm ci");
  });

  it("prints the version and help", () => {
    expect(run(["--version"]).out).toBe("devguard 0.1.0\n");
    expect(run(["--help"]).code).toBe(0);
  });
});

describe("localDate", () => {
  it("formats the local calendar date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
