import { oneLine, type Finding, type Level } from "./finding.ts";

/** Severities understood by a VS Code problem matcher. */
const SEVERITY: Record<Level, string> = { error: "error", deviation: "warning", hint: "info" };

/** Findings without a file are anchored on the declaration so the problem matcher still shows them. */
const NO_FILE = ".devguard.yaml";

/**
 * `file:line:column: severity: message [rule]`, one line per finding (SPEC §11), for the `standards: check` task's
 * problem matcher: `^(.*):(\d+):(\d+): (error|warning|info): (.*) \[(.*)\]$`.
 */
export function renderVscode(findings: readonly Finding[]): string {
  return findings
    .map((f) => {
      const where = `${f.file ?? NO_FILE}:${String(f.line ?? 1)}:${String(f.column ?? 1)}`;
      return `${where}: ${SEVERITY[f.level]}: ${oneLine(f.message)} [${f.rule}]\n`;
    })
    .join("");
}
