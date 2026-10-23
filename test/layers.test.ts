import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_LAYERS, runCheck, type CheckLayer } from "../src/check.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { GO_CLEAN_FILES, rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(declaration: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
  for (const [name, text] of Object.entries(GO_CLEAN_FILES)) writeFileSync(join(dir, name), text);
  return dir;
}

const GO = "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: go}\n";
/** A clean `go mod tidy -diff`, and golangci-lint on PATH inside the standard's range. */
const goTools: ToolRunner = {
  run: () => Promise.resolve({ code: 0, stdout: "golangci-lint has version 2.12.1", stderr: "" }),
};

describe("runCheck", () => {
  it("runs the declaration layer by default", async () => {
    const r = await runCheck({ cwd: project(GO), today: TODAY, tools: goTools });
    expect(r.standard).toBe("team@1.0.0");
    expect(r.components.map((c) => c.name)).toEqual(["./ (Go)"]);
    expect(r.findings).toEqual([]);
    expect(CHECK_LAYERS.map((l) => l.id)).toEqual([
      "declaration",
      "uncovered-files",
      "python-settings",
      "settings-go",
      "settings-java",
      "deps",
      "settings-typescript",
      "tool-versions",
      "gitattributes",
      "vscode",
      "code",
      "tests",
      "vuln",
    ]);
  });

  it("lets a later layer add findings and see the resolved declaration", async () => {
    const seen: string[] = [];
    const extra: CheckLayer = {
      id: "fake",
      run(ctx) {
        seen.push(...(ctx.resolution?.components.map((c) => c.language) ?? []));
        return Promise.resolve({ findings: [{ level: "hint", layer: "code", rule: "fake/hint", message: "hi" }] });
      },
    };
    const r = await runCheck({ cwd: project(GO), today: TODAY, tools: goTools }, [...CHECK_LAYERS, extra]);
    expect(seen).toEqual(["go"]);
    expect(rules(r.findings)).toEqual(["hint:fake/hint"]);
    expect(r.standard).toBe("team@1.0.0");
  });

  it("gives layers the repo files and the injected tool runner", async () => {
    const tools: ToolRunner = { run: () => Promise.reject(new Error("unused")) };
    let files: readonly string[] = [];
    let gotTools: ToolRunner | undefined;
    const layer: CheckLayer = {
      id: "probe",
      async run(ctx) {
        files = await ctx.files();
        gotTools = ctx.tools;
        return { findings: [] };
      },
    };
    await runCheck({ cwd: project(GO), today: TODAY, tools, listFiles: () => Promise.resolve(["a.go"]) }, [layer]);
    expect(files).toEqual(["a.go"]);
    expect(gotTools).toBe(tools);
  });
});
