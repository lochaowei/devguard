import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { vscodeInterpreterCheck } from "../src/environment/vscode-interpreter.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createEnvironmentLayer } from "../src/layers/environment.ts";
import type { EnvVars } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const decl = "standard: legacy@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-vscode-interpreter-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), decl);
  return dir;
}

async function doctor(dir: string, env: EnvVars): Promise<Finding[]> {
  const layer = createEnvironmentLayer({
    checks: [vscodeInterpreterCheck],
    exec: () => Promise.reject(new Error("no process expected")),
    env,
  });
  return (await runCheck({ cwd: dir, today: TODAY }, [declarationLayer, layer])).findings;
}

describe("doctor: the VS Code interpreter against the project environment (#115)", () => {
  it("hints, naming the environment, when UV_PROJECT_ENVIRONMENT is outside the repo and there is no .venv", async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "devguard-uv-env-"));
    dirs.push(outside);
    const findings = await doctor(dir, { UV_PROJECT_ENVIRONMENT: outside });
    expect(rules(findings)).toEqual(["hint:environment/vscode-interpreter"]);
    expect(findings[0]?.message).toContain(outside);
    expect(findings[0]?.fix).toContain("Python: Select Interpreter");
  });

  it("is silent when .venv exists", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".venv"));
    const outside = mkdtempSync(join(tmpdir(), "devguard-uv-env-"));
    dirs.push(outside);
    expect(await doctor(dir, { UV_PROJECT_ENVIRONMENT: outside })).toEqual([]);
  });

  it("is silent without UV_PROJECT_ENVIRONMENT and without .venv (the tool check reports that)", async () => {
    expect(await doctor(repo(), {})).toEqual([]);
  });

  it("is silent when the configured environment does not exist either", async () => {
    const dir = repo();
    expect(await doctor(dir, { UV_PROJECT_ENVIRONMENT: join(dir, "missing-env") })).toEqual([]);
  });
});
