import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import type { CheckScope } from "../src/layers/types.ts";
import type { Finding } from "../src/report/finding.ts";
import { TODAY } from "./helpers.ts";

/** A tiny TypeScript project that borrows this repo's node_modules, so the real ESLint, Prettier and tsc run. */
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devguard-ts-"));
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(dir, "node_modules"), "junction");
  const files: Record<string, string> = {
    // Everything except messy.ts is Prettier-clean: Prettier checks every file in the component.
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
    "package.json": '{\n  "type": "module"\n}\n',
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
    "eslint.config.js": [
      'import tseslint from "typescript-eslint";',
      'export default tseslint.config(tseslint.configs.recommended, { ignores: ["eslint.config.js"] });',
      "",
    ].join("\n"),
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "include": ["*.ts"] }\n',
    "typed.ts": 'export const answer: number = "forty-two";\n',
    "messy.ts": "export const ok = 1;\nlet  unused = 2;\n",
    "clean.ts": "export const clean = 1;\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function check(scope: CheckScope): Promise<Finding[]> {
  const listFiles = () => Promise.resolve(["typed.ts", "messy.ts", "clean.ts", "eslint.config.js"]);
  return runCheck({ cwd: dir, today: TODAY, listFiles, scope }).then((r) => r.findings);
}

const brief = (findings: Finding[]) => findings.map((f) => `${f.rule} ${f.file ?? ""}:${String(f.line ?? "")}`);

describe("TypeScript code checks with the real tools", { timeout: 120_000 }, () => {
  it("reports lint, format and type errors with file, line and rule", async () => {
    const findings = await check({ full: true });
    expect(brief(findings).sort()).toEqual(
      [
        "eslint/@typescript-eslint/no-unused-vars messy.ts:2",
        "eslint/prefer-const messy.ts:2",
        "prettier/format messy.ts:2",
        "tsc/TS2322 typed.ts:1",
      ].sort(),
    );
    expect(findings.every((f) => f.layer === "code" && f.component === "./ (TypeScript)")).toBe(true);
  });

  it("checks only the given file and category", async () => {
    expect(brief(await check({ files: ["clean.ts"], full: false }))).toContain("tsc/TS2322 typed.ts:1");
    expect(await check({ files: ["clean.ts"], only: "lint", full: false })).toEqual([]);
    expect(brief(await check({ files: ["messy.ts"], only: "format", full: false }))).toEqual([
      "prettier/format messy.ts:2",
    ]);
  });
});
