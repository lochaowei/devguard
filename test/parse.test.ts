import { describe, expect, it } from "vitest";
import { parseDeclaration } from "../src/declaration/parse.ts";
import { rules } from "./helpers.ts";

describe("parseDeclaration", () => {
  it("reads standard, components, overrides and mirrors with line numbers", () => {
    const { declaration, findings } = parseDeclaration(
      [
        "standard: team@1.0.0",
        "components:",
        "  - path: web/",
        "    language: typescript",
        "    overrides:",
        "      coverage.lines:",
        "        value: 60",
        '        reason: "legacy"',
        "mirrors:",
        "  auth: env",
      ].join("\n"),
      ".devguard.yaml",
    );
    expect(findings).toEqual([]);
    expect(declaration?.standard).toBe("team@1.0.0");
    expect(declaration?.components).toHaveLength(1);
    expect(declaration?.components[0]?.overrides).toEqual([
      { key: "coverage.lines", raw: { value: 60, reason: "legacy" }, line: 6 },
    ]);
    expect(declaration?.globalOverrides).toEqual([{ key: "mirrors.auth", raw: "env", line: 10 }]);
  });

  it("reports YAML syntax errors with a line and returns no declaration", () => {
    const { declaration, findings } = parseDeclaration("standard: [unclosed\n", ".devguard.yaml");
    expect(declaration).toBeUndefined();
    expect(findings[0]?.rule).toBe("declaration/yaml-syntax");
    expect(findings[0]?.line).toBeGreaterThan(0);
  });

  it("rejects a non-mapping root", () => {
    const { declaration, findings } = parseDeclaration("- just a list\n", ".devguard.yaml");
    expect(declaration).toBeUndefined();
    expect(rules(findings)).toEqual(["error:declaration/shape"]);
  });

  it("reports missing and malformed fields but keeps the readable parts", () => {
    const { declaration, findings } = parseDeclaration(
      [
        "standard: 1",
        "extra: true",
        "components:",
        "  - path: ./",
        "  - language: go",
        "  - nonsense",
        "  - path: web/",
        "    language: typescript",
        "    overrides: [1, 2]",
        "    colour: blue",
      ].join("\n"),
      ".devguard.yaml",
    );
    const messages = findings.map((f) => f.message);
    expect(messages).toContain("的 `standard` 必須是字串");
    expect(messages).toContain("不認得的欄位 `extra`");
    expect(messages).toContain("components[0] 缺少 `language`");
    expect(messages).toContain("components[1] 缺少 `path`");
    expect(messages).toContain("components[2] 必須是包含 path 與 language 的對應表");
    expect(messages).toContain("overrides 必須是 key: value 的對應表");
    expect(messages).toContain("components[3] 不認得的欄位 `colour`");
    expect(declaration?.components.map((c) => c.path)).toEqual(["web/"]);
  });

  it("requires components to be a list", () => {
    expect(rules(parseDeclaration("standard: team@1.0.0\n", "f").findings)).toEqual(["error:declaration/shape"]);
    expect(parseDeclaration("standard: team@1.0.0\ncomponents: {}\n", "f").findings[0]?.message).toBe(
      "`components` 必須是清單",
    );
  });
});
