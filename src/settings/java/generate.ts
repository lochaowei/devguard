import type { Repair } from "../../fix/repair.ts";
import type { JavaTarget } from "./common.ts";

const xmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function declared(t: JavaTarget, key: string): unknown {
  return t.component.effective[key]?.value ?? t.defs[key]?.value;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const indent = (lines: readonly string[], by: string): string[] => lines.map((l) => by + l);

/** The Checkstyle modules devguard generates under `TreeWalker`, as they appear there. */
export type CheckstyleModule = "CyclomaticComplexity" | "IllegalImport";

/**
 * One generated Checkstyle module element, unindented: CyclomaticComplexity at the declared limit, or IllegalImport
 * with the banned APIs (`sun.*` → illegalPkgs, a class name → illegalClasses).
 */
export function checkstyleModule(t: JavaTarget, name: CheckstyleModule): string[] {
  const prop = (key: string, value: string) => `  <property name="${key}" value="${xmlAttr(value)}"/>`;
  if (name === "CyclomaticComplexity") {
    return [`<module name="${name}">`, prop("max", String(declared(t, "complexity.cyclomatic"))), "</module>"];
  }
  const apis = strings(declared(t, "deps.bannedApis"));
  const pkgs = apis.filter((a) => a.endsWith(".*")).map((a) => a.slice(0, -2));
  const classes = apis.filter((a) => !a.endsWith(".*"));
  return [
    `<module name="${name}">`,
    ...(pkgs.length > 0 ? [prop("illegalPkgs", pkgs.join(", "))] : []),
    ...(classes.length > 0 ? [prop("illegalClasses", classes.join(", "))] : []),
    "</module>",
  ];
}

/** The CLI-owned Checkstyle config (SPEC §9.2): the CyclomaticComplexity and IllegalImport modules. */
export function checkstyleXml(t: JavaTarget): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">',
    '<module name="Checker">',
    '  <module name="TreeWalker">',
    ...indent(checkstyleModule(t, "CyclomaticComplexity"), "    "),
    ...indent(checkstyleModule(t, "IllegalImport"), "    "),
    "  </module>",
    "</module>",
    "",
  ].join("\n");
}

/** The generated PMD rule element for CognitiveComplexity at the declared limit, unindented. */
export function pmdCognitiveRule(t: JavaTarget): string[] {
  return [
    '<rule ref="category/java/design.xml/CognitiveComplexity">',
    "  <properties>",
    `    <property name="reportLevel" value="${String(declared(t, "complexity.cognitive"))}"/>`,
    "  </properties>",
    "</rule>",
  ];
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
    ...indent(pmdCognitiveRule(t), "  "),
    "</ruleset>",
    "",
  ].join("\n");
}

/** The whole content of a CLI-owned Java config file: the Checkstyle config or, otherwise, the PMD ruleset. */
export function generatedContent(t: JavaTarget, file: string): string {
  return /checkstyle\.xml$/.test(file) ? checkstyleXml(t) : pmdRulesetXml(t);
}

/** Regenerates a CLI-owned Java config file. */
export function regenerate(t: JavaTarget, file: string): Repair[] {
  return [{ op: "generate", file, content: generatedContent(t, file) }];
}
