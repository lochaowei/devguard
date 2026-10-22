import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meetsMinimum } from "../scripts/build-exe.ts";
import { pathWithoutNode, runSmoke } from "../scripts/smoke-exe.ts";

const CLI = [process.execPath, join(import.meta.dirname, "..", "src", "cli.ts")];

describe("runSmoke", () => {
  it("passes --version and check on a sample project for a working devguard", () => {
    const results = runSmoke(CLI, "0.1.0");
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["--version", true],
      ["check（範例專案）", true],
      ["check（缺少宣告）", true],
    ]);
  });

  it("fails when the executable reports another version", () => {
    const results = runSmoke(CLI, "9.9.9");
    expect(results[0]).toMatchObject({ name: "--version", ok: false });
    expect(results[0]?.detail).toContain("devguard 0.1.0");
  });

  it("fails every step when the executable cannot start", () => {
    const results = runSmoke([join(import.meta.dirname, "no-such.exe")], "0.1.0");
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

describe("pathWithoutNode", () => {
  it("removes every PATH entry that contains node.exe", () => {
    const hasNode = (dir: string) => dir === "C:\\nodejs" || dir === "C:\\Users\\me\\.volta\\bin";
    expect(pathWithoutNode("C:\\Windows;C:\\nodejs;C:\\tools;C:\\Users\\me\\.volta\\bin", hasNode)).toBe(
      "C:\\Windows;C:\\tools",
    );
  });
});

describe("meetsMinimum", () => {
  it("compares dotted versions numerically", () => {
    expect(meetsMinimum("1.2.23", "1.2.23")).toBe(true);
    expect(meetsMinimum("1.4.3\n", "1.2.23")).toBe(true);
    expect(meetsMinimum("1.2.9", "1.2.23")).toBe(false);
    expect(meetsMinimum("0.9.99", "1.2.23")).toBe(false);
    expect(meetsMinimum("garbage", "1.2.23")).toBe(false);
  });
});
