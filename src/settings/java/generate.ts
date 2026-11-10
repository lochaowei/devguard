import type { Repair } from "../../fix/repair.ts";
import type { JavaTarget } from "./common.ts";

function declared(t: JavaTarget, key: string): unknown {
  return t.component.effective[key]?.value ?? t.defs[key]?.value;
}

/**
 * PMD reports a method whose complexity is *at or above* its report level (`>=`, CognitiveComplexityRule and
 * CyclomaticComplexityRule alike), while a standard's `max` is the largest value allowed. So the level written is one
 * above the limit.
 */
export const reportLevelFor = (limit: number): number => limit + 1;

/** The report level that enforces the declared limit of `key`. */
function level(t: JavaTarget, key: string): string {
  const limit = declared(t, key);
  return String(typeof limit === "number" ? reportLevelFor(limit) : limit);
}

const indent = (lines: readonly string[], by: string): string[] => lines.map((l) => by + l);

/** The generated PMD rule element for CognitiveComplexity at the declared limit, unindented. */
export function pmdCognitiveRule(t: JavaTarget): string[] {
  return [
    '<rule ref="category/java/design.xml/CognitiveComplexity">',
    "  <properties>",
    `    <property name="reportLevel" value="${level(t, "complexity.cognitive")}"/>`,
    "  </properties>",
    "</rule>",
  ];
}

/** The generated PMD rule element for CyclomaticComplexity at the declared limit, unindented. */
export function pmdCyclomaticRule(t: JavaTarget): string[] {
  return [
    '<rule ref="category/java/design.xml/CyclomaticComplexity">',
    "  <properties>",
    `    <property name="methodReportLevel" value="${level(t, "complexity.cyclomatic")}"/>`,
    "  </properties>",
    "</rule>",
  ];
}

/** The rule that carries the banned APIs; the checks look for it by this name. */
export const BANNED_APIS_RULE = "BannedApis";

/** The declared banned APIs (`deps.bannedApis`): `a.b.*` for a package, a class name otherwise. */
export function bannedApis(t: JavaTarget): string[] {
  const value = declared(t, "deps.bannedApis");
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** The XPath conditions that match an import of the API: the package and what is under it, or the class. */
function importMatches(api: string): string[] {
  if (api.endsWith(".*")) {
    const pkg = api.slice(0, -2);
    return [`@ImportedName = '${pkg}'`, `starts-with(@ImportedName, '${pkg}.')`];
  }
  return [`@ImportedName = '${api}'`, `starts-with(@ImportedName, '${api}.')`];
}

/**
 * The generated PMD rule that flags an import of any declared banned API (`deps.bannedApis`), unindented; none when
 * nothing is banned. PMD has no built-in rule for this, so it is an XPath rule over the import declarations.
 */
export function pmdBannedApisRule(t: JavaTarget): string[] {
  const apis = bannedApis(t);
  if (apis.length === 0) return [];
  const xpath = `//ImportDeclaration[${apis.flatMap(importMatches).join(" or ")}]`;
  return [
    `<rule name="${BANNED_APIS_RULE}" language="java" class="net.sourceforge.pmd.lang.rule.xpath.XPathRule"`,
    '      message="Import of a banned API (deps.bannedApis)">',
    "  <description>由 devguard 依 deps.bannedApis 產生</description>",
    "  <priority>2</priority>",
    "  <properties>",
    '    <property name="xpath">',
    `      <value><![CDATA[${xpath}]]></value>`,
    "    </property>",
    "  </properties>",
    "</rule>",
  ];
}

/** The CLI-owned PMD ruleset: PMD's quickstart rules plus the complexity limits and the banned APIs. */
export function pmdRulesetXml(t: JavaTarget): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ruleset name="devguard" xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"',
    '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '    xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">',
    "  <description>由 devguard 依宣告的標準產生</description>",
    '  <rule ref="rulesets/java/quickstart.xml"/>',
    ...indent(pmdCognitiveRule(t), "  "),
    ...indent(pmdCyclomaticRule(t), "  "),
    ...indent(pmdBannedApisRule(t), "  "),
    "</ruleset>",
    "",
  ].join("\n");
}

/** The whole content of a CLI-owned Java config file: the PMD ruleset. */
export function generatedContent(t: JavaTarget): string {
  return pmdRulesetXml(t);
}

/** Regenerates a CLI-owned Java config file. */
export function regenerate(t: JavaTarget, file: string): Repair[] {
  return [{ op: "generate", file, content: generatedContent(t) }];
}
