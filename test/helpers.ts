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
