import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { runCodeFix } from "../src/fix/code.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { codeLayer } from "../src/layers/code.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { TODAY } from "./helpers.ts";

/** golangci-lint and Go are not dependencies of this repo: these run only where both are on PATH. */
const goToolsInstalled = ["golangci-lint", "go"].every(
  (tool) => spawnSync(tool, ["version"], { encoding: "utf8" }).status === 0,
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPEATS = 5;

/** A Go module with REPEATS identical misspell issues and REPEATS identical errcheck issues: more than golangci-lint's defaults keep. */
function repeatedIssuesModule(): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-golangci-"));
  dirs.push(dir);
  const lines = Array.from({ length: REPEATS }, (_, i) => `\t// teh step ${String(i)}\n\tos.Remove("x${String(i)}")`);
  const files: Record<string, string> = {
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: go\n",
    // The project's own limits, which devguard overrides so that check sees every issue (#90).
    ".golangci.yml":
      'version: "2"\nlinters:\n  default: none\n  enable: [errcheck, misspell]\nissues:\n  max-same-issues: 2\n',
    "go.mod": "module example.com/same\n\ngo 1.26\n",
    "main.go": `package main\n\nimport "os"\n\nfunc main() {\n${lines.join("\n")}\n}\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const lint = (cwd: string) =>
  runCheck({ cwd, today: TODAY, scope: { only: "lint", full: false } }, [declarationLayer, codeLayer]).then((r) =>
    r.findings.map((f) => f.rule),
  );

const YES: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

describe.runIf(goToolsInstalled)("Go code checks with the real golangci-lint", { timeout: 300_000 }, () => {
  it("reports every repeated issue, whatever max-same-issues says (#90)", async () => {
    const rules = await lint(repeatedIssuesModule());
    expect(rules.filter((r) => r === "golangci-lint/errcheck")).toHaveLength(REPEATS);
    expect(rules.filter((r) => r === "golangci-lint/misspell")).toHaveLength(REPEATS);
  });

  // A smoke test: golangci-lint's --fix applies fixes past the caps even without the flags, so the argument
  // assertion in fix-code.test.ts is what guards fix --code's flags.
  it("fixes every repeated issue in one fix --code (#90)", async () => {
    const cwd = repeatedIssuesModule();
    await runCodeFix({ cwd, today: TODAY, io: YES });
    expect(readFileSync(join(cwd, "main.go"), "utf8")).not.toContain("teh");
  });

  it("queues behind another golangci-lint run instead of failing (#94)", async () => {
    const [a, b] = [repeatedIssuesModule(), repeatedIssuesModule()];
    const rules = (await Promise.all([lint(a), lint(b), lint(a), lint(b)])).flat();
    expect(rules).not.toContain("code/tool-failed");
    expect(rules.filter((r) => r === "golangci-lint/errcheck")).toHaveLength(4 * REPEATS);
  });
});
