import type { Finding } from "../../report/finding.ts";
import { child, descendants, type XmlEl } from "../../xml/parse.ts";
import {
  finding,
  findConfig,
  generated,
  isFinding,
  judgeNumber,
  readXmlConfig,
  snippet,
  type JavaTarget,
  type OwnConfig,
} from "./common.ts";
import { BANNED_APIS_RULE, bannedApis, pmdBannedApisRule, pmdCognitiveRule, pmdCyclomaticRule } from "./generate.ts";

/** Where the PMD ruleset is looked for, relative to the component. */
export const PMD_FILES = ["pmd-ruleset.xml", "pmd.xml", "config/pmd/ruleset.xml", "config/pmd/pmd.xml"] as const;

const CATEGORY = "category/java/design.xml";

/** A complexity rule the ruleset must have, with the standard item it carries. */
interface ComplexityRule {
  name: string;
  /** The standard item the rule's limit comes from. */
  key: string;
  /** The rule property that holds the limit. */
  property: string;
  /** PMD's own default for that property: a report level, not a limit. */
  fallback: string;
  lines: (t: JavaTarget) => string[];
}

const COMPLEXITY_RULES: readonly ComplexityRule[] = [
  {
    name: "CognitiveComplexity",
    key: "complexity.cognitive",
    property: "reportLevel",
    fallback: "15",
    lines: pmdCognitiveRule,
  },
  {
    name: "CyclomaticComplexity",
    key: "complexity.cyclomatic",
    property: "methodReportLevel",
    fallback: "10",
    lines: pmdCyclomaticRule,
  },
];

/** A `<rule ref=".../Name">`, or the whole design category without an exclude for it. */
function findRule(root: XmlEl, name: string): XmlEl | undefined {
  const rules = descendants(root, "rule");
  const direct = rules.find((r) => (r.attrs.ref ?? "").endsWith(`/${name}`));
  if (direct) return direct;
  return rules.find(
    (r) => r.attrs.ref === CATEGORY && !r.children.some((c) => c.name === "exclude" && c.attrs.name === name),
  );
}

function property(rule: XmlEl, name: string): XmlEl | undefined {
  const properties = child(rule, "properties");
  return properties?.children.find((p) => p.name === "property" && p.attrs.name === name);
}

/** The value of a `<property>`, written as an attribute or as a `<value>` element. */
const valueOf = (p: XmlEl): string => p.attrs.value ?? child(p, "value")?.text ?? "";

/** What a finding about a PMD ruleset devguard did not generate prints: the rule to add or replace. */
function own(text: string, name: string, lines: readonly string[], present: boolean): OwnConfig {
  const where = present ? `把 ruleset 中的 ${name} 設定換成：` : "加在 ruleset 底下：";
  return { text, missing: snippet(where, lines) };
}

function ruleMissing(t: JavaTarget, file: string, text: string, name: string, key: string, lines: string[]): Finding {
  return finding(t, "error", "settings/pmd-rule-missing", `${file}：缺少 PMD 的 ${name}（${key}）`, {
    file,
    ...generated(t, file, own(text, name, lines, false)),
  });
}

function checkComplexity(t: JavaTarget, file: string, text: string, root: XmlEl, spec: ComplexityRule): Finding[] {
  const lines = spec.lines(t);
  const rule = findRule(root, spec.name);
  if (!rule) return [ruleMissing(t, file, text, spec.name, spec.key, lines)];
  const level = property(rule, spec.property);
  // PMD reports at or above the level; the standard's limit is the largest value allowed.
  const written = (level ? valueOf(level) : spec.fallback).trim();
  const raw = /^\d+$/.test(written) ? String(Math.max(0, Number(written) - 1)) : written;
  return judgeNumber(t, spec.key, raw, {
    file,
    line: (level ?? rule).line,
    setting: `${spec.name} ${spec.property}`,
    own: own(text, spec.name, lines, true),
  });
}

/** Whether the XPath of the banned-APIs rule matches an import of the API (the literal the generator writes). */
const covers = (xpath: string, api: string): boolean =>
  api.endsWith(".*") ? xpath.includes(`'${api.slice(0, -1)}'`) : xpath.includes(`'${api}'`);

/** The BannedApis rule must flag an import of every API the standard bans (`deps.bannedApis`). */
function checkBannedApis(t: JavaTarget, file: string, text: string, root: XmlEl): Finding[] {
  const apis = bannedApis(t);
  if (apis.length === 0) return [];
  const lines = pmdBannedApisRule(t);
  const rule = descendants(root, "rule").find((r) => r.attrs.name === BANNED_APIS_RULE);
  if (!rule) return [ruleMissing(t, file, text, BANNED_APIS_RULE, "deps.bannedApis", lines)];
  const xpathProperty = property(rule, "xpath");
  const xpath = xpathProperty ? valueOf(xpathProperty) : "";
  const missing = apis.filter((api) => !covers(xpath, api));
  if (missing.length === 0) return [];
  return [
    finding(
      t,
      "error",
      "settings/banned-api-not-enforced",
      `${file}：PMD 的 ${BANNED_APIS_RULE} 沒有涵蓋禁用 API ${missing.join("、")}`,
      { file, line: rule.line, ...generated(t, file, own(text, BANNED_APIS_RULE, lines, true)) },
    ),
  ];
}

/**
 * Checks the PMD ruleset of a Java component: CognitiveComplexity and CyclomaticComplexity with their limits per the
 * declaration, and a rule that flags imports of the banned APIs.
 */
export async function checkPmd(t: JavaTarget): Promise<Finding[]> {
  const file = findConfig(t, PMD_FILES);
  if (!file) {
    return [
      finding(
        t,
        "error",
        "settings/pmd-missing",
        `找不到 PMD 規則集（${PMD_FILES.join("、")}）`,
        generated(t, t.component.dir + PMD_FILES[0]),
      ),
    ];
  }
  const config = await readXmlConfig(t, file);
  if (isFinding(config)) return [config];
  const { root, text } = config;
  return [
    ...COMPLEXITY_RULES.flatMap((spec) => checkComplexity(t, file, text, root, spec)),
    ...checkBannedApis(t, file, text, root),
  ];
}
