import { describe, expect, it } from "vitest";
import { failureMessage, UsageError } from "../src/report/failure.ts";
import { ToolMissingError } from "../src/tools/runner.ts";

describe("failureMessage (exit 2)", () => {
  it("names the missing tool with a one-line install command", () => {
    expect(failureMessage(new ToolMissingError("找不到 ruff", "uv sync"), "USAGE")).toBe(
      "找不到 ruff\n  安裝：uv sync\n",
    );
  });

  it("shows usage after usage errors", () => {
    expect(failureMessage(new UsageError("bad"), "USAGE")).toBe("bad\n\nUSAGE");
    expect(failureMessage(Object.assign(new Error("x"), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }), "U")).toBe(
      "x\n\nU",
    );
  });

  it("reports anything else as an internal error", () => {
    expect(failureMessage(new Error("boom"), "U")).toBe("devguard 內部錯誤：boom\n");
    expect(failureMessage("str", "U")).toBe("devguard 內部錯誤：str\n");
  });
});
