// Fixture gotcha: a Python component checks only `.py` files, while a TypeScript component formats (and, staged,
// reads through `git show`) every changed file whatever its extension. A test that a directory, submodule or other
// odd path never reaches the tools needs a TypeScript component, or it passes without the fix (#142, #147).
import { parseDeclaration } from "../src/declaration/parse.ts";
import { resolveDeclaration, type Resolution } from "../src/declaration/resolve.ts";
import type { Finding } from "../src/report/finding.ts";
import type { GitHookName } from "../src/hooks/file.ts";
import { readFileSync } from "node:fs";

/** The hook `lefthook install` (2.2.2) wrote, with the machine-specific lefthook path made generic. */
export const lefthookWrote = (hook: GitHookName): string =>
  readFileSync(new URL(`./fixtures/lefthook/${hook}`, import.meta.url), "utf8");

/**
 * The hook husky 4.1.0–4.3.8 wrote (`getHookScript`), with the machine-specific paths made generic: it ends by loading
 * `husky.sh`, which exits, so nothing after it runs (#126).
 */
export const HUSKY_V4_HOOK = readFileSync(new URL("./fixtures/husky-v4/pre-commit", import.meta.url), "utf8");

/** `text` with `line` put right after its first line (the `#!` line). */
export const afterShebang = (text: string, line: string): string => text.replace(/\n/, `\n${line}\n`);

export const TODAY = "2026-10-22";

/** Parses and resolves a declaration text; fails the test if the YAML itself cannot be read. */
export function resolveText(yaml: string, today = TODAY): Resolution & { parseFindings: Finding[] } {
  const parsed = parseDeclaration(yaml, ".devguard.yaml");
  if (!parsed.declaration) throw new Error("unparseable: " + JSON.stringify(parsed.findings));
  return { ...resolveDeclaration(parsed.declaration, today), parseFindings: parsed.findings };
}

export function rules(findings: Finding[]): string[] {
  return findings.map((f) => `${f.level}:${f.rule}`);
}

/** `.golangci.yml` and `go.mod` that meet team@1.0.0, for a Go component's directory. */
export const GO_CLEAN_FILES: Readonly<Record<string, string>> = {
  ".golangci.yml": `version: "2"
linters:
  enable: [gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard]
  settings:
    cyclop:
      max-complexity: 10
    gocognit:
      min-complexity: 15
    depguard:
      rules:
        main:
          deny:
            - pkg: io/ioutil
              desc: use io and os
formatters:
  enable: [gofumpt, goimports]
`,
  "go.mod": "module example.com/app\n\ngo 1.26\n",
};
