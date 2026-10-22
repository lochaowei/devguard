import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDate } from "../src/check.ts";
import { GO_CLEAN_FILES } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const dirs: string[] = [];

function project(declaration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  if (declaration !== undefined) writeFileSync(join(dir, ".devguard.yaml"), declaration);
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

describe("devguard check", () => {
  it("exits 0 for a clean declaration", () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - {path: ./, language: go}\n");
    for (const [name, text] of Object.entries(GO_CLEAN_FILES)) writeFileSync(join(dir, name), text);
    const r = run(["check", "--cwd", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("通過");
  });

  it("exits 0 with deviations, 1 with --strict", () => {
    const dir = project(DEVIATING);
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
    const r = run(["check", "--cwd", project(DEVIATING), "--format", "json"]);
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

describe("localDate", () => {
  it("formats the local calendar date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
