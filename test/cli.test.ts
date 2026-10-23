import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, "package-lock.json"), "{}");
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

/** Writes TypeScript tool configs that meet team@1.0.0, with the given coverage threshold. */
function writeTsConfigs(dir: string, coverage: number): void {
  const tsOptions = ["strict", "noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"];
  const thresholds = ["lines", "branches", "functions", "statements"]
    .map((k) => `${k}: ${String(coverage)}`)
    .join(", ");
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: Object.fromEntries(tsOptions.map((o) => [o, true])) }),
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
    "eslint.config.js":
      'export default [tseslint.configs.strictTypeChecked, { rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] } }];',
    "vitest.config.ts": `export default { test: { coverage: { thresholds: { ${thresholds} } } } };`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

/** DEVIATING plus web/ tool configs that match it, so the deviation is the only finding. */
function deviatingProject(): string {
  const dir = project(DEVIATING);
  const web = join(dir, "web");
  mkdirSync(web);
  writeTsConfigs(web, 60);
  return dir;
}

describe("devguard check", () => {
  it("exits 0 for a clean declaration", () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - {path: ./, language: typescript}\n");
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

  it("exits 2 on usage errors", () => {
    expect(run(["frobnicate"]).code).toBe(2);
    expect(run(["check", "--format", "xml"]).code).toBe(2);
    expect(run(["check", "--nope"]).code).toBe(2);
    expect(run([]).code).toBe(2);
  });

  it("prints the version and help", () => {
    expect(run(["--version"]).out).toBe("devguard 0.1.0\n");
    expect(run(["--help"]).code).toBe(0);
  });
});

describe("devguard draft", () => {
  /** A project with no declaration whose web/ TypeScript component has a coverage threshold of 60. */
  function undeclared(): string {
    const dir = project();
    const web = join(dir, "web");
    mkdirSync(join(web, "src"), { recursive: true });
    writeTsConfigs(web, 60);
    writeFileSync(join(web, "package.json"), "{}");
    writeFileSync(join(web, "src", "app.ts"), "");
    return dir;
  }

  it("is what check suggests when the declaration is missing", () => {
    expect(run(["check", "--cwd", project()]).out).toContain("devguard draft");
  });

  it("writes a draft that check rejects until the TODO reasons are filled in", () => {
    const dir = undeclared();
    const r = run(["draft", "--cwd", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".devguard.yaml");
    const text = readFileSync(join(dir, ".devguard.yaml"), "utf8");
    expect(text).toContain("path: web/");
    expect(text).toContain("coverage.lines");

    const todo = run(["check", "--cwd", dir, "--format", "json"]);
    expect(todo.code).toBe(1);
    expect(todo.out).toContain("declaration/todo-reason");

    writeFileSync(join(dir, ".devguard.yaml"), text.replace(/reason: .*TODO.*/, "reason: legacy tests"));
    expect(run(["check", "--cwd", dir]).code).toBe(0);
  });

  it("does not overwrite an existing declaration", () => {
    const existing = "standard: team@1.0.0\ncomponents: []\n";
    const dir = project(existing);
    const r = run(["draft", "--cwd", dir]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(".devguard.yaml");
    expect(readFileSync(join(dir, ".devguard.yaml"), "utf8")).toBe(existing);
  });
});

describe("localDate", () => {
  it("formats the local calendar date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
