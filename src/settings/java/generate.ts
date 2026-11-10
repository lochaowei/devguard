import type { Repair } from "../../fix/repair.ts";
import type { JavaTarget } from "./common.ts";

function declared(t: JavaTarget, key: string): unknown {
  return t.component.effective[key]?.value ?? t.defs[key]?.value;
}

const indent = (lines: readonly string[], by: string): string[] => lines.map((l) => by + l);

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

/** The whole content of a CLI-owned Java config file: the PMD ruleset. */
export function generatedContent(t: JavaTarget): string {
  return pmdRulesetXml(t);
}

/** Regenerates a CLI-owned Java config file. */
export function regenerate(t: JavaTarget, file: string): Repair[] {
  return [{ op: "generate", file, content: generatedContent(t) }];
}
