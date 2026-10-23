import { describe, expect, it } from "vitest";
import type { Finding } from "../src/report/finding.ts";
import { claudeFeedback } from "../src/report/claude.ts";
import { renderSarif } from "../src/report/sarif.ts";
import { renderVscode } from "../src/report/vscode.ts";

const f = (level: Finding["level"], extra: Partial<Finding> = {}): Finding => ({
  level,
  layer: "code",
  rule: `r/${level}`,
  message: `${level} message`,
  ...extra,
});

describe("renderVscode", () => {
  it("prints one problem-matcher line per finding", () => {
    const out = renderVscode([
      f("error", { file: "web/src/a.ts", line: 4, column: 7, rule: "eslint/no-var", message: "Unexpected var" }),
      f("deviation", { file: ".devguard.yaml", line: 3 }),
      f("hint", { file: "web/src/b.ts" }),
    ]);
    expect(out).toBe(
      [
        "web/src/a.ts:4:7: error: Unexpected var [eslint/no-var]",
        ".devguard.yaml:3:1: warning: deviation message [r/deviation]",
        "web/src/b.ts:1:1: info: hint message [r/hint]",
        "",
      ].join("\n"),
    );
  });

  it("anchors findings without a file on the declaration and keeps each on one line", () => {
    expect(renderVscode([f("error", { message: "tsc 執行失敗：\nboom\n  at x" })])).toBe(
      ".devguard.yaml:1:1: error: tsc 執行失敗： boom at x [r/error]\n",
    );
  });
});

describe("renderSarif", () => {
  const sarif = (findings: Finding[]) =>
    JSON.parse(renderSarif({ components: [], findings }, "0.1.0")) as {
      version: string;
      $schema: string;
      runs: {
        tool: { driver: { name: string; version: string; rules: { id: string }[] } };
        invocations: { executionSuccessful: boolean; toolExecutionNotifications: unknown[] }[];
        results: unknown[];
      }[];
    };

  it("is a SARIF 2.1.0 log with only code findings as results", () => {
    const log = sarif([
      f("error", { file: "web/src/a.ts", line: 4, column: 7, rule: "eslint/no-var", message: "Unexpected var" }),
      f("hint", { file: "web/src/b.ts", rule: "eslint/no-var", message: "again" }),
      f("deviation", { layer: "config", file: ".devguard.yaml", line: 3 }),
      f("error", { layer: "environment", rule: "tools/missing" }),
    ]);
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    const [run] = log.runs;
    expect(run?.tool.driver).toMatchObject({ name: "devguard", version: "0.1.0", rules: [{ id: "eslint/no-var" }] });
    expect(run?.results).toEqual([
      {
        ruleId: "eslint/no-var",
        ruleIndex: 0,
        level: "error",
        message: { text: "Unexpected var" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "web/src/a.ts", uriBaseId: "%SRCROOT%" },
              region: { startLine: 4, startColumn: 7 },
            },
          },
        ],
      },
      {
        ruleId: "eslint/no-var",
        ruleIndex: 0,
        level: "note",
        message: { text: "again" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "web/src/b.ts", uriBaseId: "%SRCROOT%" },
              region: { startLine: 1 },
            },
          },
        ],
      },
    ]);
    expect(run?.invocations).toEqual([{ executionSuccessful: true, toolExecutionNotifications: [] }]);
  });

  it("reports code findings without a file (a tool that failed) as notifications, not results", () => {
    const [run] = sarif([f("error", { rule: "code/tool-failed", message: "tsc 執行失敗" })]).runs;
    expect(run?.results).toEqual([]);
    expect(run?.invocations).toEqual([
      {
        executionSuccessful: false,
        toolExecutionNotifications: [
          { level: "error", message: { text: "tsc 執行失敗" }, descriptor: { id: "code/tool-failed" } },
        ],
      },
    ]);
  });
});

describe("claudeFeedback", () => {
  it("lists findings most severe first with location, rule and fix", () => {
    const out = claudeFeedback([
      f("hint", { file: "a.ts" }),
      f("error", { file: "web/src/a.ts", line: 4, column: 7, fix: "devguard fix --code web/src/a.ts" }),
    ]);
    expect(out).toBe(
      [
        "devguard：1 個錯誤、0 個偏離、1 個提示",
        "- 錯誤 web/src/a.ts:4:7 error message [r/error]（修正：devguard fix --code web/src/a.ts）",
        "- 提示 a.ts hint message [r/hint]",
      ].join("\n"),
    );
  });

  it("says pass when there is nothing to report", () => {
    expect(claudeFeedback([])).toBe("devguard：通過：沒有錯誤、偏離或提示");
  });

  it("lists at most 20 items and counts the rest", () => {
    const out = claudeFeedback(Array.from({ length: 25 }, (_, i) => f("error", { file: `f${String(i)}.ts` })));
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(20);
    expect(out).toContain("- 錯誤 f19.ts ");
    expect(out.endsWith("還有 5 項")).toBe(true);
  });

  it("stays under 4,000 characters however long the messages are", () => {
    const long = "很長的訊息".repeat(100);
    const out = claudeFeedback(Array.from({ length: 20 }, () => f("error", { message: long })));
    expect(out.length).toBeLessThan(4000);
    expect(out).toMatch(/還有 \d+ 項$/);
  });

  it("shortens a single oversized item instead of dropping it", () => {
    const out = claudeFeedback([f("error", { message: "x".repeat(5000) })]);
    expect(out.length).toBeLessThan(4000);
    expect(out).toContain("- 錯誤 xxx");
    expect(out).toContain("…");
    expect(out).not.toContain("還有");
  });
});
