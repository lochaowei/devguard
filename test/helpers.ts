import { parseDeclaration } from "../src/declaration/parse.ts";
import { resolveDeclaration, type Resolution } from "../src/declaration/resolve.ts";
import type { Finding } from "../src/report/finding.ts";

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
