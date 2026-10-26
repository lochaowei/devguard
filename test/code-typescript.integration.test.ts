import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { codeLayer } from "../src/layers/code.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
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
  // Only the code layer is under test; the sample project is not meant to satisfy the settings/deps layers.
  return runCheck({ cwd: dir, today: TODAY, listFiles, scope }, [declarationLayer, codeLayer]).then((r) => r.findings);
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

  it("checks the staged version of a file through stdin when one is given (SPEC §7.4)", async () => {
    const staged = (path: string) => Promise.resolve(path === "clean.ts" ? "let  unstaged = 2;\n" : undefined);
    const listFiles = () => Promise.resolve(["clean.ts"]);
    const lintAndFormat = async (only: "lint" | "format") =>
      brief(
        (
          await runCheck(
            {
              cwd: dir,
              today: TODAY,
              listFiles,
              scope: { files: ["clean.ts"], only, full: false },
              stagedText: staged,
            },
            [declarationLayer, codeLayer],
          )
        ).findings,
      ).sort();
    expect(await lintAndFormat("lint")).toEqual([
      "eslint/@typescript-eslint/no-unused-vars clean.ts:1",
      "eslint/prefer-const clean.ts:1",
    ]);
    expect(await lintAndFormat("format")).toEqual(["prettier/format clean.ts:1"]);
  });

  describe("files besides the TypeScript sources: the tools decide which they handle (#55, #56)", () => {
    const others: Record<string, string> = {
      "tool.mjs": "export const used = 1;\nconst unused = 2;\n",
      ".babelrc": '{"presets":[]}\n',
      ".editorconfig.yaml": "root:   true\n",
      LICENSE: "MIT   License\n",
      "notes.txt": "anything   goes\n",
    };
    const all = [".devguard.yaml", "package.json", ".prettierrc", "tsconfig.json", "eslint.config.js"];
    const listed = [...all, "typed.ts", "messy.ts", "clean.ts", ...Object.keys(others)];
    const lintAndFormat = (findings: Finding[]) =>
      brief(findings.filter((f) => /^(eslint|prettier)\//.test(f.rule))).sort();
    const run = (scope: CheckScope, stagedText?: (path: string) => Promise<string | undefined>) =>
      runCheck(
        {
          cwd: dir,
          today: TODAY,
          listFiles: () => Promise.resolve(listed),
          scope,
          ...(stagedText ? { stagedText } : {}),
        },
        [declarationLayer, codeLayer],
      ).then((r) => r.findings);

    beforeAll(() => {
      for (const [name, text] of Object.entries(others)) writeFileSync(join(dir, name), text);
    });
    afterAll(() => {
      for (const name of Object.keys(others)) rmSync(join(dir, name), { force: true });
    });

    it("reports the same lint and format findings for the given files as the whole-component check", async () => {
      const whole = lintAndFormat(await run({ full: true }));
      expect(whole).toEqual(
        [
          "eslint/@typescript-eslint/no-unused-vars messy.ts:2",
          "eslint/prefer-const messy.ts:2",
          "eslint/@typescript-eslint/no-unused-vars tool.mjs:2",
          "prettier/format messy.ts:2",
          "prettier/format .babelrc:1",
          "prettier/format .editorconfig.yaml:1",
        ].sort(),
      );
      expect(lintAndFormat(await run({ files: listed, full: false }))).toEqual(whole);
    });

    it("checks the staged versions the same way, with nothing for the files no tool handles", async () => {
      const staged = (path: string) =>
        Promise.resolve(path in others || path === ".prettierrc" ? (others[path] ?? "printWidth:   120\n") : undefined);
      const files = [...Object.keys(others), ".prettierrc"];
      const findings = await run({ files, full: false }, staged);
      expect(findings.filter((f) => f.rule === "code/tool-failed")).toEqual([]);
      expect(lintAndFormat(findings)).toEqual(
        [
          "eslint/@typescript-eslint/no-unused-vars tool.mjs:2",
          "prettier/format .babelrc:1",
          "prettier/format .editorconfig.yaml:1",
          "prettier/format .prettierrc:1",
        ].sort(),
      );
      // Only non-source files are given: no type check.
      expect(findings.filter((f) => f.rule.startsWith("tsc/"))).toEqual([]);
    });
  });

  it("checks only the given file and category", async () => {
    expect(brief(await check({ files: ["clean.ts"], full: false }))).toContain("tsc/TS2322 typed.ts:1");
    expect(await check({ files: ["clean.ts"], only: "lint", full: false })).toEqual([]);
    expect(brief(await check({ files: ["messy.ts"], only: "format", full: false }))).toEqual([
      "prettier/format messy.ts:2",
    ]);
  });
});
