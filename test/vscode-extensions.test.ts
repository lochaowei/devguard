import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { createVscodeExtensionsCheck } from "../src/environment/vscode-extensions.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createEnvironmentLayer } from "../src/layers/environment.ts";
import type { Command, Exec } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(declaration: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-vscode-ext-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  return dir;
}

const GO = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: go\n";
const PYTHON = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";

/** A fake `code` that lists the given extensions; records how it was started. */
function fakeCode(installed: string[]): Exec & { calls: Command[] } {
  const calls: Command[] = [];
  const exec = (command: Command) => {
    calls.push(command);
    return Promise.resolve({ code: 0, stdout: installed.map((id) => `${id}@1.0.0\n`).join(""), stderr: "" });
  };
  return Object.assign(exec, { calls });
}

async function doctor(dir: string, exec: Exec, platform: NodeJS.Platform = "win32"): Promise<Finding[]> {
  const checks = [createVscodeExtensionsCheck({ platform })];
  const layers = [declarationLayer, createEnvironmentLayer({ checks, exec, env: {} })];
  const { findings } = await runCheck({ cwd: dir, today: TODAY }, layers);
  return findings.filter((f) => f.layer === "environment");
}

describe("VS Code extensions installed (SPEC §7.2 環境檢查)", () => {
  it("runs code.cmd --list-extensions --show-versions on Windows (through cmd.exe) and passes when all are installed", async () => {
    const code = fakeCode(["golang.go"]);
    expect(await doctor(repo(GO), code)).toEqual([]);
    expect(code.calls.map((c) => [c.file, ...c.args])).toEqual([["code.cmd", "--list-extensions", "--show-versions"]]);
  });

  it("runs plain `code` elsewhere", async () => {
    const code = fakeCode(["golang.go"]);
    await doctor(repo(GO), code, "linux");
    expect(code.calls[0]?.file).toBe("code");
  });

  it("a missing recommended extension is an error pointing at the internal marketplace", async () => {
    const findings = await doctor(repo(PYTHON), fakeCode(["ms-python.python", "charliermarsh.ruff"]));
    expect(rules(findings)).toEqual(["error:environment/vscode-extension-missing"]);
    expect(findings[0]?.message).toContain("ms-python.mypy-type-checker");
    expect(findings[0]?.message).toContain("若已安裝但被停用，請在 VS Code 中啟用");
    expect(findings[0]?.fix).toContain(
      "https://vsmarketplace.example.internal/items?itemName=ms-python.mypy-type-checker",
    );
  });

  it("an installed extension the standard does not recommend is a hint", async () => {
    const all = ["ms-python.python", "charliermarsh.ruff", "ms-python.mypy-type-checker", "ms-python.black-formatter"];
    expect(rules(await doctor(repo(PYTHON), fakeCode(all)))).toEqual(["hint:environment/vscode-extension-unwanted"]);
  });

  it("matches extension ids case-insensitively", async () => {
    expect(await doctor(repo(GO), fakeCode(["Golang.Go"]))).toEqual([]);
  });

  it("hints when the code command is not on PATH", async () => {
    const missing: Exec = () => Promise.reject(Object.assign(new Error("spawn code ENOENT"), { code: "ENOENT" }));
    expect(rules(await doctor(repo(GO), missing))).toEqual(["hint:environment/vscode-cli-missing"]);
  });

  it("hints when the code command fails", async () => {
    const failing: Exec = () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    expect(rules(await doctor(repo(GO), failing))).toEqual(["hint:environment/vscode-cli-failed"]);
  });

  it("does not run code when no language is declared", async () => {
    const code = fakeCode([]);
    expect(await doctor(repo("standard: team@1.0.0\ncomponents: []\n"), code)).toEqual([]);
    expect(code.calls).toEqual([]);
  });
});
