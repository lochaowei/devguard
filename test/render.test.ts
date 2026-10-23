import { describe, expect, it } from "vitest";
import type { Finding } from "../src/report/finding.ts";
import { exitCodeFor, problemsOnly, renderJson, renderText, summaryLine } from "../src/report/render.ts";

const f = (level: Finding["level"], extra: Partial<Finding> = {}): Finding => ({
  level,
  layer: "config",
  rule: `r/${level}`,
  message: `${level} message`,
  ...extra,
});

describe("problemsOnly (doctor --quiet)", () => {
  it("keeps errors and deviations and drops hints", () => {
    const input = { components: [], findings: [f("error"), f("deviation"), f("hint")] };
    expect(problemsOnly(input).findings.map((x) => x.level)).toEqual(["error", "deviation"]);
  });
});

describe("exitCodeFor", () => {
  it("passes with only deviations and hints", () => {
    expect(exitCodeFor([f("deviation"), f("hint")], false)).toBe(0);
  });
  it("fails on errors", () => {
    expect(exitCodeFor([f("error")], false)).toBe(1);
  });
  it("fails on deviations with --strict", () => {
    expect(exitCodeFor([f("deviation")], true)).toBe(1);
    expect(exitCodeFor([f("hint")], true)).toBe(0);
  });
});

describe("renderText", () => {
  const findings = [
    f("hint", { component: "web/ (TypeScript)" }),
    f("error", { component: "web/ (TypeScript)", file: ".devguard.yaml", line: 7, fix: "do x" }),
    f("deviation"),
  ];
  const input = { standard: "team@1.0.0", components: [], findings };

  it("groups by component, orders by level, collapses hints and ends with a summary", () => {
    const text = renderText(input);
    expect(text).toContain("標準：team@1.0.0");
    expect(text.indexOf("web/ (TypeScript)")).toBeLessThan(text.indexOf("（整體）"));
    expect(text).toContain("錯誤  error message  [r/error] .devguard.yaml:7");
    expect(text).toContain("修正：do x");
    expect(text).toContain("提示  共 1 項（加上 --verbose 顯示）");
    expect(text.trimEnd().endsWith("1 個錯誤、1 個偏離、1 個提示")).toBe(true);
  });

  it("expands hints with verbose", () => {
    expect(renderText(input, true)).toContain("提示  hint message");
  });

  it("says pass when there is nothing to report", () => {
    expect(summaryLine([])).toBe("通過：沒有錯誤、偏離或提示");
  });
});

describe("renderJson", () => {
  it("emits standard, components and findings", () => {
    const json = JSON.parse(
      renderJson({ components: [{ name: "./ (Go)", dir: "", language: "go" }], findings: [f("error")] }),
    ) as Record<string, unknown>;
    expect(json).toEqual({
      standard: null,
      components: [{ path: "./", language: "go" }],
      findings: [{ level: "error", layer: "config", rule: "r/error", message: "error message", fixable: false }],
    });
  });

  it("gives every finding its layer and whether fix resolves it", () => {
    const json = JSON.parse(
      renderJson({
        components: [],
        findings: [f("error", { layer: "code", fix: "devguard fix --code a.ts" }), f("hint", { layer: "environment" })],
      }),
    ) as { findings: Finding[] };
    expect(json.findings.map((x) => [x.layer, x.fixable])).toEqual([
      ["code", true],
      ["environment", false],
    ]);
  });
});

describe("renderText fixability", () => {
  it("marks whether each finding can be fixed with devguard fix", () => {
    const text = renderText({
      components: [],
      findings: [
        f("error", { rule: "a", fix: "devguard fix" }),
        f("error", { rule: "b", fix: "手動修正型別錯誤" }),
        f("error", { rule: "c" }),
        f("error", { rule: "d", fix: "改寫 pom.xml", fixable: true }),
      ],
    });
    expect(text).toContain("[a]\n        可用 fix 修正：devguard fix\n");
    expect(text).toContain("[b]\n        需手動修正：手動修正型別錯誤\n");
    expect(text).toContain("[c]\n        需手動修正\n");
    expect(text).toContain("[d]\n        可用 fix 修正：改寫 pom.xml\n");
  });
});
