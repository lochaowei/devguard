import { CLI_INSTALL_HINT } from "../src/distribution.ts";
import { describe, expect, it } from "vitest";
import { resolveText, rules } from "./helpers.ts";

const head = "standard: team@1.0.0\ncomponents:\n";
const web = (overrides: string) => `${head}  - path: web/\n    language: typescript\n    overrides:\n${overrides}`;

describe("resolveDeclaration — scenarios from the prototype", () => {
  it("1. follows the defaults with no findings", () => {
    const r = resolveText(`${head}  - path: ./\n    language: python\n`);
    expect(r.findings).toEqual([]);
    expect(r.components[0]?.dir).toBe("");
    expect(r.components[0]?.effective["coverage.lines"]).toEqual({ value: 80, source: "default", status: "same" });
  });

  it("2. a loosened coverage needs a reason, becomes a deviation, then an error once expired", () => {
    expect(rules(resolveText(web("      coverage.lines: 60\n")).findings)).toEqual([
      "error:declaration/looser-without-reason",
    ]);
    const withReason = resolveText(web('      coverage.lines: {value: 60, reason: "legacy", until: 2027-03-31}\n'));
    expect(rules(withReason.findings)).toEqual(["deviation:declaration/deviation"]);
    expect(withReason.findings[0]?.message).toContain("到期：2027-03-31");
    expect(withReason.findings[0]?.component).toBe("web/ (TypeScript)");
    const expired = resolveText(web('      coverage.lines: {value: 60, reason: "legacy", until: 2026-01-01}\n'));
    expect(rules(expired.findings)).toEqual(["error:declaration/deviation-expired"]);
  });

  it("3. tightening and allowed alternatives are fine; unlisted tools, unbanning and unknown keys are not", () => {
    const r = resolveText(
      web(
        [
          "      complexity.cyclomatic: 8",
          "      lint.tool: biome",
          "      deps.banned: [request]",
          "      coverage.foo: 1",
          "",
        ].join("\n"),
      ),
    );
    expect(rules(r.findings)).toEqual(["error:declaration/looser-without-reason", "error:declaration/unknown-item"]);
    expect(r.components[0]?.effective["complexity.cyclomatic"]?.status).toBe("stricter");
    expect(r.components[0]?.effective["lint.tool"]?.status).toBe("alternative");
    const unlisted = resolveText(web("      lint.tool: rome\n"));
    expect(rules(unlisted.findings)).toEqual(["error:declaration/looser-without-reason"]);
  });

  it("5. draft TODO reasons stay errors until filled in", () => {
    const r = resolveText(web('      coverage.lines: {value: 70, reason: "TODO: 由 vitest.config.ts 推得"}\n'));
    expect(rules(r.findings)).toEqual(["error:declaration/todo-reason"]);
  });
});

describe("resolveDeclaration — other rules", () => {
  it("style items can be overridden freely, but drift between same-language components is hinted", () => {
    const r = resolveText(
      `${head}  - path: a/\n    language: typescript\n    overrides:\n      format.printWidth: 100\n  - path: b/\n    language: typescript\n`,
    );
    expect(rules(r.findings)).toEqual(["hint:declaration/style-inconsistent"]);
    expect(r.components[0]?.effective["format.printWidth"]?.status).toBe("different");
  });

  it("hints when a reason is given for something that is not looser", () => {
    const r = resolveText(web('      complexity.cyclomatic: {value: 8, reason: "why not"}\n'));
    expect(rules(r.findings)).toEqual(["hint:declaration/unneeded-reason"]);
  });

  it("rejects invalid values and malformed until dates", () => {
    expect(rules(resolveText(web("      coverage.lines: lots\n")).findings)).toEqual([
      "error:declaration/invalid-value",
    ]);
    expect(rules(resolveText(web('      coverage.lines: {value: 60, reason: "x", until: soon}\n')).findings)).toEqual([
      "error:declaration/invalid-until",
    ]);
  });

  it("each ignored vulnerability needs an id, a reason and an until date", () => {
    const r = resolveText(
      web(
        [
          "      deps.ignoredVulns:",
          '        - {id: GHSA-ok, reason: "no fix yet", until: 2027-01-01}',
          '        - {id: GHSA-nodate, reason: "x"}',
          "        - {id: GHSA-noreason, until: 2027-01-01}",
          '        - {id: GHSA-old, reason: "x", until: 2026-01-01}',
          "        - just-a-string",
          "",
        ].join("\n"),
      ),
    );
    expect(rules(r.findings)).toEqual([
      "deviation:declaration/deviation",
      "error:declaration/ignored-vuln-without-until",
      "error:declaration/looser-without-reason",
      "error:declaration/deviation-expired",
      "error:declaration/invalid-value",
    ]);
  });

  it("reports unknown languages and duplicate components", () => {
    const r = resolveText(
      `${head}  - path: x/\n    language: ruby\n  - path: ./web\n    language: typescript\n  - path: web/\n    language: typescript\n`,
    );
    expect(rules(r.findings)).toEqual(["error:declaration/unknown-language", "error:declaration/duplicate-component"]);
  });

  it("applies mirrors as global items: same-host URLs are free, other hosts looser, auth must be none or env", () => {
    const internal = "https://nexus.example.internal/repository/npm-group/";
    const ok = resolveText(`${head}  - path: ./\n    language: go\nmirrors:\n  auth: env\n  npm: ${internal}\n`);
    expect(ok.findings).toEqual([]);
    expect(ok.global["mirrors.auth"]?.status).toBe("alternative");
    expect(ok.global["mirrors.npm"]?.status).toBe("different");
    const external = resolveText(`${head}  - path: ./\n    language: go\nmirrors:\n  npm: https://other/\n`);
    expect(rules(external.findings)).toEqual(["error:declaration/looser-without-reason"]);
    const notUrl = resolveText(`${head}  - path: ./\n    language: go\nmirrors:\n  npm: other\n`);
    expect(rules(notUrl.findings)).toEqual(["error:declaration/invalid-value"]);
    const bad = resolveText(`${head}  - path: ./\n    language: go\nmirrors:\n  auth: kerberos\n  ftp: x\n`);
    expect(rules(bad.findings)).toEqual(["error:declaration/looser-without-reason", "error:declaration/unknown-item"]);
  });

  it.each([
    ["team@1", "standard/malformed", undefined],
    ["acme@1.0.0", "standard/unknown-name", undefined],
    ["team@9.0.0", "standard/newer-than-cli", `更新 devguard：${CLI_INSTALL_HINT}`],
    ["team@0.1.0", "standard/no-longer-bundled", "devguard standard upgrade"],
  ])("standard %s → %s", (id, rule, fix) => {
    const r = resolveText(`standard: ${id}\ncomponents: []\n`);
    expect(r.findings.map((f) => [f.rule, f.fix, f.line])).toEqual([[rule, fix, 1]]);
    expect(r.standard).toBeUndefined();
  });
});

describe("resolveDeclaration — ignore and declared components (#35)", () => {
  const decl = (ignore: string) =>
    `${head}  - path: ./\n    language: go\n  - path: web/\n    language: typescript\n` +
    `  - path: web/api/\n    language: python\nignore: ${ignore}\n`;
  const hints = (ignore: string) =>
    resolveText(decl(ignore))
      .findings.filter((f) => f.rule === "declaration/ignored-component")
      .map((f) => [f.level, f.component, f.line]);

  it("hints that a component's file checks are skipped when an ignore entry covers its whole directory", () => {
    expect(hints("[web/]")).toEqual([
      ["hint", "web/ (TypeScript)", 5],
      ["hint", "web/api/ (Python)", 7],
    ]);
    expect(hints("['web/api/**']")).toEqual([["hint", "web/api/ (Python)", 7]]);
    expect(hints("['**']")).toHaveLength(3);
    const [finding] = resolveText(decl("[web/api]")).findings;
    expect(finding?.message).toContain("web/api");
    expect(finding?.message).toContain("測試與弱點掃描仍會執行");
  });

  it("does not hint for entries that cover only part of a component", () => {
    expect(hints("['web/*.gen.ts', web/api/fixtures/, '**/*.pb.go', webapp/]")).toEqual([]);
  });
});
