import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { testsLayer } from "../src/layers/tests.ts";
import type { CheckScope } from "../src/layers/types.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

/** Helpers for the tests-and-coverage layer: a temp project and `check --full` with a fake tool runner. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp project with `.devguard.yaml` and the given repo files. */
export function project(declaration: string, files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

/** One component declared at `path` with `language`, optionally with a flow-mapping `overrides`. */
export function declare(path: string, language: string, overrides?: string): string {
  const extra = overrides === undefined ? "" : `, overrides: ${overrides}`;
  return `standard: team@1.0.0\ncomponents:\n  - {path: ${path}, language: ${language}${extra}}\n`;
}

/** The value of a `--name=value` (or `-name=value`) argument. */
export function argValue(req: ToolRequest, name: string): string {
  const arg = (req.args ?? []).find((a) => a.startsWith(`${name}=`));
  if (arg === undefined) throw new Error(`no ${name} in ${JSON.stringify(req.args)}`);
  return arg.slice(name.length + 1);
}

export const ok = (stdout = "", code = 0, stderr = ""): ToolResult => ({ code, stdout, stderr });

/** A tool runner that answers each request with `answer` and records the requests. */
export function fakeTools(answer: (req: ToolRequest) => ToolResult) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      return Promise.resolve(answer(req));
    },
  };
  return { tools, calls };
}

/** `devguard check` with the declaration and tests layers only. */
export function checkTests(cwd: string, tools: ToolRunner, files: string[], scope: CheckScope = { full: true }) {
  return runCheck({ cwd, today: TODAY, tools, listFiles: () => Promise.resolve(files), scope }, [
    declarationLayer,
    testsLayer,
  ]);
}
