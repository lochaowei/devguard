import { describe, expect, it } from "vitest";
import { toolFailed } from "../src/code/support.ts";
import type { CodeTarget } from "../src/code/types.ts";
import { reportMissing, testToolFailed } from "../src/testing/coverage.ts";
import type { TestTarget } from "../src/testing/types.ts";

// #128: tool output carries ANSI colour codes (Vitest colours even when not on a terminal), which must not reach
// finding messages and through them the text, JSON, SARIF and hook reports.

const testTarget: TestTarget = {
  component: "(TypeScript)",
  dir: "",
  language: "typescript",
  effective: {},
  threshold: 80,
  deviation: false,
};
const codeTarget: CodeTarget = {
  component: "(TypeScript)",
  dir: "",
  language: "typescript",
  effective: {},
  categories: new Set(["lint"]),
};

/** What Vitest printed in jquense/yup without `@vitest/coverage-v8` (#128). */
const VITEST_MISSING_COVERAGE =
  "\x1b[31m\x1b[7m\x1b[31m MISSING DEPENDENCY \x1b[31m\x1b[27m Cannot find dependency '@vitest/coverage-v8'\n\n\x1b[39m\n";

describe("tool output in finding messages (#128)", () => {
  it("test/tool-failed drops Vitest's colour codes and the lines they leave, keeping one line", () => {
    const finding = testToolFailed(testTarget, "vitest", { code: 1, stdout: "", stderr: VITEST_MISSING_COVERAGE });
    expect(finding.message).toBe(
      "vitest 執行失敗（exit 1）：MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'",
    );
  });

  it("code/tool-failed keeps up to five coloured lines, without the colour codes or the lines they leave", () => {
    const stderr = "\x1b[2m\x1b[22m\n\x1b[31mone\x1b[39m\n\ntwo\n\x1b[1mthree\x1b[22m\nfour\nfive\nsix\n\x1b[39m";
    const finding = toolFailed(codeTarget, "eslint", { code: 2, stdout: "", stderr });
    expect(finding.message).toBe("eslint 執行失敗（exit 2）：one\ntwo\nthree\nfour\nfive");
  });

  it("falls back to stdout when stderr holds nothing but colour codes", () => {
    const finding = toolFailed(codeTarget, "tsc", { code: 2, stdout: "error TS5058", stderr: "\x1b[39m\n" });
    expect(finding.message).toBe("tsc 執行失敗（exit 2）：error TS5058");
  });

  it("test/tool-failed keeps the last five lines, not counting lines only colour codes filled", () => {
    const stderr = "zero\none\ntwo\nthree\nfour\n\x1b[31mfive\x1b[39m\n\x1b[39m\n\x1b[0m\n";
    const finding = testToolFailed(testTarget, "pytest", { code: 4, stdout: "", stderr });
    expect(finding.message).toBe("pytest 執行失敗（exit 4）：one\ntwo\nthree\nfour\nfive");
  });

  it("coverage/no-report keeps the last three lines of the detail, without colour codes", () => {
    const detail = "first\n\x1b[33mNo data to report.\x1b[39m\n\nsecond\nthird\n\x1b[0m\n";
    const finding = reportMissing(testTarget, "coverage json", "run coverage", detail);
    expect(finding.message).toBe("找不到覆蓋率報告 coverage json，無法判定覆蓋率（No data to report. second third）");
  });

  it("leaves uncoloured output as it was", () => {
    const finding = toolFailed(codeTarget, "ruff", { code: 2, stdout: "", stderr: "  error: bad\n    at line 3\n" });
    expect(finding.message).toBe("ruff 執行失敗（exit 2）：error: bad\n    at line 3");
  });
});
