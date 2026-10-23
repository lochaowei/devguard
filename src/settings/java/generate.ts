import type { Repair } from "../../fix/repair.ts";
import type { JavaTarget } from "./common.ts";

const xmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function declared(t: JavaTarget, key: string): unknown {
  return t.component.effective[key]?.value ?? t.defs[key]?.value;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The CLI-owned Checkstyle config (SPEC §9.2): the declared cyclomatic complexity limit and the banned APIs
 * (`sun.*` → illegalPkgs, a class name → illegalClasses).
 */
export function checkstyleXml(t: JavaTarget): string {
  const apis = strings(declared(t, "deps.bannedApis"));
  const pkgs = apis.filter((a) => a.endsWith(".*")).map((a) => a.slice(0, -2));
  const classes = apis.filter((a) => !a.endsWith(".*"));
  const prop = (name: string, value: string) => `      <property name="${name}" value="${xmlAttr(value)}"/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">',
    '<module name="Checker">',
    '  <module name="TreeWalker">',
    '    <module name="CyclomaticComplexity">',
    prop("max", String(declared(t, "complexity.cyclomatic"))),
    "    </module>",
    '    <module name="IllegalImport">',
    ...(pkgs.length > 0 ? [prop("illegalPkgs", pkgs.join(", "))] : []),
    ...(classes.length > 0 ? [prop("illegalClasses", classes.join(", "))] : []),
    "    </module>",
    "  </module>",
    "</module>",
    "",
  ].join("\n");
}

/** The CLI-owned PMD ruleset: PMD's quickstart rules plus CognitiveComplexity at the declared limit. */
export function pmdRulesetXml(t: JavaTarget): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ruleset name="devguard" xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"',
    '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '    xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">',
    "  <description>由 devguard 依宣告的標準產生</description>",
    '  <rule ref="rulesets/java/quickstart.xml"/>',
    '  <rule ref="category/java/design.xml/CognitiveComplexity">',
    "    <properties>",
    `      <property name="reportLevel" value="${String(declared(t, "complexity.cognitive"))}"/>`,
    "    </properties>",
    "  </rule>",
    "</ruleset>",
    "",
  ].join("\n");
}

/** Regenerates a CLI-owned Java config file: the Checkstyle config or, otherwise, the PMD ruleset. */
export function regenerate(t: JavaTarget, file: string): Repair[] {
  return [{ op: "generate", file, content: /checkstyle\.xml$/.test(file) ? checkstyleXml(t) : pmdRulesetXml(t) }];
}
