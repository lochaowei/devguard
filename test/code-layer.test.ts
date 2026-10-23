import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck, type CheckOptions } from "../src/check.ts";
import { codeLayer } from "../src/layers/code.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { uncoveredFilesLayer } from "../src/layers/uncovered.ts";
import { ToolMissingError, type ToolRequest, type ToolRunner } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(declaration: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  return dir;
}

/** The layers under test: settings/deps/tool-version layers are covered by their own tests. */
const LAYERS = [declarationLayer, uncoveredFilesLayer, codeLayer];

const API = "standard: team@1.0.0\ncomponents:\n  - {path: api/, language: python}\n";
const WEB = "standard: team@1.0.0\ncomponents:\n  - {path: web/, language: typescript}\n  - {path: ./, language: go}\n";

/** Every tool passes; records what ran. */
function passingTools() {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const json = req.tool === "eslint" || (req.tool === "ruff" && req.args?.[0] === "check");
      return Promise.resolve({ code: 0, stdout: json ? "[]" : "", stderr: "" });
    },
  };
  return { tools, calls };
}

const summary = (calls: ToolRequest[]) => calls.map((c) => `${c.dir}:${c.tool} ${(c.args ?? []).join(" ")}`);

function check(options: Partial<CheckOptions> & { files: string[] }) {
  const { files, ...rest } = options;
  return runCheck({ cwd: project(WEB), today: TODAY, listFiles: () => Promise.resolve(files), ...rest }, LAYERS);
}

describe("code checks in devguard check", () => {
  it("runs lint, format and type checks on each TypeScript component", async () => {
    const { tools, calls } = passingTools();
    const r = await check({ tools, files: ["web/src/a.ts", "main.go", "README.md"] });
    expect(summary(calls)).toEqual([
      "web/:eslint --format json --no-warn-ignored .",
      "web/:prettier --list-different .",
      "web/:tsc --noEmit --pretty false",
    ]);
    expect(r.findings).toEqual([]);
  });

  it("reports tool findings attributed to the component", async () => {
    const tools: ToolRunner = {
      run: (req) =>
        Promise.resolve(
          req.tool === "tsc"
            ? { code: 2, stdout: "src/a.ts(1,7): error TS2322: Bad.\n", stderr: "" }
            : { code: 0, stdout: req.tool === "eslint" ? "[]" : "", stderr: "" },
        ),
    };
    const r = await check({ tools, files: ["web/src/a.ts"] });
    expect(r.findings).toEqual([
      expect.objectContaining({
        layer: "code",
        rule: "tsc/TS2322",
        component: "web/ (TypeScript)",
        file: "web/src/a.ts",
      }),
    ]);
  });

  it("skips components without files", async () => {
    const { tools, calls } = passingTools();
    await check({ tools, files: ["main.go"] });
    expect(calls).toEqual([]);
  });

  it("checks only the given files, and type-checks the components they belong to", async () => {
    const { tools, calls } = passingTools();
    await check({ tools, files: ["web/a.ts", "web/b.ts"], scope: { files: ["web/b.ts", "notes.md"], full: false } });
    expect(summary(calls)).toEqual([
      "web/:eslint --format json --no-warn-ignored b.ts",
      "web/:prettier --list-different b.ts",
      "web/:tsc --noEmit --pretty false",
    ]);
  });

  it("runs only the category named by --only", async () => {
    const { tools, calls } = passingTools();
    await check({ tools, files: ["web/a.ts"], scope: { only: "typecheck", full: false } });
    expect(summary(calls)).toEqual(["web/:tsc --noEmit --pretty false"]);
  });

  it("runs every category with --full", async () => {
    const { tools, calls } = passingTools();
    await check({ tools, files: ["web/a.ts"], scope: { full: true } });
    expect(calls.map((c) => c.tool)).toEqual(["eslint", "prettier", "tsc"]);
  });

  it("checks files no component covers with the default standard, from the repo root, and hints", async () => {
    const { tools, calls } = passingTools();
    const r = await check({ tools, files: ["web/a.ts", "scripts/x.ts", "tools/y.ts", "lib/z.py"] });
    expect(summary(calls)).toContain("web/:eslint --format json --no-warn-ignored .");
    expect(summary(calls)).toContain(":eslint --format json --no-warn-ignored scripts/x.ts tools/y.ts");
    expect(rules(r.findings)).toEqual(["hint:declaration/uncovered-files", "hint:declaration/uncovered-files"]);
    const ts = r.findings.find((f) => f.message.includes("TypeScript"));
    expect(ts?.message).toContain("建議在宣告中補上元件");
    expect(ts?.file).toBe("scripts/x.ts");
    expect(r.findings.some((f) => f.message.includes("Python"))).toBe(true);
    expect(summary(calls)).toContain(":ruff check --output-format json --no-fix --force-exclude lib/z.py");
  });

  it("runs Ruff and mypy on a Python component, honouring file arguments and --only", async () => {
    const declaration = API;
    const listFiles = () => Promise.resolve(["api/app.py", "api/util.py"]);
    const run = async (scope: CheckOptions["scope"]) => {
      const { tools, calls } = passingTools();
      await runCheck({ cwd: project(declaration), today: TODAY, tools, listFiles, scope }, LAYERS);
      return summary(calls);
    };
    expect(await run({ files: ["api/util.py"], full: false })).toEqual([
      "api/:ruff check --output-format json --no-fix --force-exclude util.py",
      "api/:ruff format --diff --force-exclude util.py",
      "api/:mypy --no-pretty --no-error-summary --show-error-codes --no-color-output .",
    ]);
    expect(await run({ only: "format", full: false })).toEqual(["api/:ruff format --diff --force-exclude ."]);
  });

  it("fails with ToolMissingError (exit 2, uv sync) when a Python tool is not installed", async () => {
    const declaration = API;
    const tools: ToolRunner = {
      run: () => Promise.reject(new ToolMissingError("找不到 ruff：專案環境（.venv）中沒有安裝", "cd api && uv sync")),
    };
    const options = { cwd: project(declaration), today: TODAY, tools, listFiles: () => Promise.resolve(["api/a.py"]) };
    await expect(runCheck(options, LAYERS)).rejects.toMatchObject({ install: "cd api && uv sync" });
  });

  it("fails with ToolMissingError (exit 2, npm ci) when a tool is not installed", async () => {
    const tools: ToolRunner = {
      run: () => Promise.reject(new ToolMissingError("找不到 eslint：node_modules 中沒有安裝", "cd web && npm ci")),
    };
    await expect(check({ tools, files: ["web/a.ts"] })).rejects.toMatchObject({ install: "cd web && npm ci" });
  });

  it("still checks code when the declaration is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devguard-"));
    dirs.push(dir);
    const { tools, calls } = passingTools();
    const r = await runCheck({ cwd: dir, today: TODAY, tools, listFiles: () => Promise.resolve(["a.ts"]) }, LAYERS);
    expect(calls.map((c) => c.tool)).toEqual(["eslint", "prettier", "tsc"]);
    expect(rules(r.findings)).toEqual(["error:declaration/missing"]);
  });
});
