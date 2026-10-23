import { describe, expect, it } from "vitest";
import { checkGoSettings } from "../src/settings/go.ts";
import { GO_CLEAN_FILES, resolveText, rules } from "./helpers.ts";

const GOOD = GO_CLEAN_FILES[".golangci.yml"] ?? "";
const GOMOD = GO_CLEAN_FILES["go.mod"] ?? "";

function component(overrides = "") {
  const r = resolveText(
    `standard: team@1.0.0\ncomponents:\n  - path: backend/\n    language: go\n${overrides ? `    overrides:\n${overrides}` : ""}`,
  );
  const c = r.components[0];
  if (!c) throw new Error("no component");
  return c;
}

function check(golangci: string | undefined, gomod: string | undefined = GOMOD, overrides = "") {
  return checkGoSettings(component(overrides), { golangci, gomod });
}

describe("checkGoSettings", () => {
  it("passes a config that meets the standard", () => {
    expect(check(GOOD)).toEqual([]);
  });

  it("reports unreadable YAML once, with its line", () => {
    const findings = check('version: "2"\nlinters: [\n');
    expect(rules(findings)).toEqual(["error:settings/golangci-yaml-syntax"]);
    expect(findings[0]?.line).toBeGreaterThan(0);
  });

  it("reports a .golangci.yml that is not version 2", () => {
    const findings = check(GOOD.replace('version: "2"', 'version: "1"'));
    expect(rules(findings)).toEqual(["error:settings/golangci-version"]);
    expect(findings[0]).toMatchObject({ layer: "config", component: "backend/ (Go)", file: "backend/.golangci.yml" });
    expect(rules(check(GOOD.replace('version: "2"\n', "")))).toEqual(["error:settings/golangci-version"]);
  });

  it("reports each required linter that is not enabled", () => {
    const findings = check(GOOD.replace("gosec, revive, ", ""));
    expect(rules(findings)).toEqual([
      "error:settings/golangci-linter-missing",
      "error:settings/golangci-linter-missing",
    ]);
    expect(findings.map((f) => f.message).join("\n")).toMatch(/gosec[\s\S]*revive/);
  });

  it("counts the v2 standard set unless linters.default turns it off", () => {
    const none = check(GOOD.replace("linters:\n", "linters:\n  default: none\n"));
    expect(none.map((f) => f.message.match(/「(\w+)」/)?.[1])).toEqual([
      "errcheck",
      "govet",
      "ineffassign",
      "staticcheck",
      "unused",
    ]);
    expect(check(GOOD.replace("linters:\n", "linters:\n  default: all\n  disable: [unused]\n")).length).toBe(1);
    expect(check(GOOD.replace("linters:\n", "linters:\n  default: all\n"))).toEqual([]);
  });

  it("requires the linters the declaration adds, and not the ones it removes with a reason", () => {
    const added = `      lint.rules: [errcheck, govet, ineffassign, staticcheck, unused, gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard, gocritic]\n`;
    expect(rules(check(GOOD, GOMOD, added))).toEqual(["error:settings/golangci-linter-missing"]);
    const removed = `      lint.rules:\n        value: [errcheck, govet, ineffassign, staticcheck, unused, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard]\n        reason: legacy\n`;
    expect(check(GOOD.replace("gosec, ", ""), GOMOD, removed)).toEqual([]);
  });

  it("errors when cyclop or gocognit is looser than declared, hints when stricter", () => {
    const looser = check(GOOD.replace("max-complexity: 10", "max-complexity: 12"));
    expect(rules(looser)).toEqual(["error:settings/looser"]);
    expect(looser[0]).toMatchObject({ file: "backend/.golangci.yml", line: 6 });
    const stricter = check(GOOD.replace("min-complexity: 15", "min-complexity: 12"));
    expect(rules(stricter)).toEqual(["hint:settings/stricter"]);
  });

  it("compares against the declared override, not the default", () => {
    const cyclo = "      complexity.cyclomatic: 8\n";
    expect(rules(check(GOOD, GOMOD, cyclo))).toEqual(["error:settings/looser"]);
    expect(check(GOOD.replace("max-complexity: 10", "max-complexity: 8"), GOMOD, cyclo)).toEqual([]);
  });

  it("treats a missing cyclop.max-complexity as its default 10", () => {
    expect(check(GOOD.replace("      max-complexity: 10\n", "      {}\n"))).toEqual([]);
  });

  it("requires gocognit.min-complexity to be set explicitly (its default is 30)", () => {
    const findings = check(GOOD.replace("      min-complexity: 15\n", "      {}\n"));
    expect(rules(findings)).toEqual(["error:settings/golangci-unset"]);
    expect(findings[0]?.message).toContain("30");
  });

  it("requires explicit depguard rules", () => {
    const noRules = GOOD.replace(/ {4}depguard:\n[\s\S]*?(?=formatters:)/, "");
    expect(rules(check(noRules))).toEqual(["error:settings/golangci-depguard-rules"]);
    const empty = GOOD.replace(/ {6}rules:\n[\s\S]*?(?=formatters:)/, "      rules: {}\n");
    expect(rules(check(empty))).toEqual(["error:settings/golangci-depguard-rules"]);
  });

  it("reports declared formatters that are not enabled", () => {
    const findings = check(GOOD.replace("[gofumpt, goimports]", "[gofmt]"));
    expect(rules(findings)).toEqual([
      "error:settings/golangci-formatter-missing",
      "error:settings/golangci-formatter-missing",
    ]);
    const declaredGofmt = "      format.tools: [gofmt]\n";
    expect(check(GOOD.replace("[gofumpt, goimports]", "[gofmt]"), GOMOD, declaredGofmt)).toEqual([]);
    expect(rules(check(GOOD, GOMOD, declaredGofmt))).toEqual(["error:settings/golangci-formatter-missing"]);
    expect(rules(check(GOOD.replace("formatters:\n  enable: [gofumpt, goimports]\n", "")))).toEqual([
      "error:settings/golangci-formatter-missing",
      "error:settings/golangci-formatter-missing",
    ]);
  });

  it("errors when go.mod's go version is below the standard, accepts a higher one", () => {
    const low = check(GOOD, "module x\n\ngo 1.25.3\n");
    expect(rules(low)).toEqual(["error:settings/gomod-go-version"]);
    expect(low[0]).toMatchObject({ file: "backend/go.mod", line: 3 });
    expect(check(GOOD, "module x\n\ngo 1.27\n")).toEqual([]);
    expect(check(GOOD, "module x\r\ngo 1.26.0\r\n")).toEqual([]);
    expect(rules(check(GOOD, "module x\n"))).toEqual(["error:settings/gomod-go-version"]);
  });
});
