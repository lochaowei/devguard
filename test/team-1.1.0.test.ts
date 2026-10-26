import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.ts";
import { createStandardUpgradeCheck } from "../src/environment/standard-upgrade.ts";
import { runStandardUpgrade } from "../src/standard/upgrade-run.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

// team@1.1.0 as this CLI bundles it (#39): no bundled-standard injection, so these go through the real registry.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-team110-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

/** A TypeScript project on team@1.0.0 that widened the sonarjs range with a reason. */
const TS_ON_1_0_0 =
  "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n    overrides:\n" +
  '      tools.eslint-plugin-sonarjs:\n        value: ">=3,<5"\n        reason: "peer dependency"\n';

const noTools: ToolRunner = {
  run: () => Promise.reject(new Error("no tools in this test")),
  manage: () => Promise.reject(new Error("no package commands expected")),
};

async function upgrade(dir: string, apply = false) {
  let out = "";
  const write = (t: string) => (out += t);
  const code = await runStandardUpgrade({ cwd: dir, today: TODAY, apply, tools: noTools, write });
  return { code, out };
}

describe("team@1.1.0 is the newest bundled standard (#39)", () => {
  it("doctor suggests upgrading team@1.0.0 to team@1.1.0", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.0.0\ncomponents: []\n" });
    const { findings } = await runDoctor({ cwd: dir, today: TODAY, checks: [createStandardUpgradeCheck()] });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "standard/upgrade-available", fix: "devguard standard upgrade team@1.1.0" }),
    );
  });

  it("standard upgrade previews dropping eslint-plugin-sonarjs and the override it makes pointless", async () => {
    const dir = repo({ ".devguard.yaml": TS_ON_1_0_0 });
    const { code, out } = await upgrade(dir);
    expect(code).toBe(1);
    expect(out).toContain("team@1.0.0 → team@1.1.0");
    expect(out).toContain('TypeScript｜eslint-plugin-sonarjs 版本範圍：">=3,<4"（移除）');
    expect(out).toContain("tools.eslint-plugin-sonarjs（新標準已移除這個項目）");
    expect(read(dir, ".devguard.yaml")).toBe(TS_ON_1_0_0);
  });

  it("standard upgrade --apply moves the declaration to team@1.1.0 and drops the sonarjs override", async () => {
    const dir = repo({ ".devguard.yaml": TS_ON_1_0_0 });
    expect((await upgrade(dir, true)).code).toBe(0);
    const decl = read(dir, ".devguard.yaml");
    expect(decl).toContain("standard: team@1.1.0");
    expect(decl).not.toContain("eslint-plugin-sonarjs");
  });
});
