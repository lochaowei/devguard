import type { Finding, Level } from "./finding.ts";
import type { ReportInput } from "./render.ts";

const SARIF_LEVEL: Record<Level, "error" | "warning" | "note"> = { error: "error", deviation: "warning", hint: "note" };

function region(f: Finding): Record<string, number> {
  return { startLine: f.line ?? 1, ...(f.column === undefined ? {} : { startColumn: f.column }) };
}

/**
 * SARIF 2.1.0 for code review platforms (SPEC §11): only code findings. Paths are repo-relative, resolved against
 * `%SRCROOT%`. Code findings without a file (a tool that could not run) cannot be placed in the code, so they are
 * tool execution notifications instead of results, and mark the run as unsuccessful.
 */
export function renderSarif(input: ReportInput, version: string): string {
  const code = input.findings.filter((f) => f.layer === "code");
  const located = code.filter((f) => f.file !== undefined);
  const unlocated = code.filter((f) => f.file === undefined);
  const ruleIds = [...new Set(located.map((f) => f.rule))];
  const log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "devguard",
            version,
            informationUri: "https://github.com/lochaowei/devguard",
            rules: ruleIds.map((id) => ({ id })),
          },
        },
        invocations: [
          {
            executionSuccessful: unlocated.length === 0,
            toolExecutionNotifications: unlocated.map((f) => ({
              level: SARIF_LEVEL[f.level],
              message: { text: f.message },
              descriptor: { id: f.rule },
            })),
          },
        ],
        results: located.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIds.indexOf(f.rule),
          level: SARIF_LEVEL[f.level],
          message: { text: f.message },
          locations: [
            { physicalLocation: { artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" }, region: region(f) } },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(log, null, 2) + "\n";
}
