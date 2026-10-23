import type { Finding } from "../../report/finding.ts";
import { child, descendants, type XmlEl } from "../../xml/parse.ts";
import { finding, findConfig, generated, isFinding, judgeNumber, readXmlConfig, type JavaTarget } from "./common.ts";

/** Where the PMD ruleset is looked for, relative to the component. */
export const PMD_FILES = ["pmd-ruleset.xml", "pmd.xml", "config/pmd/ruleset.xml", "config/pmd/pmd.xml"] as const;

const RULE = "CognitiveComplexity";
const CATEGORY = "category/java/design.xml";
/** PMD's own default for CognitiveComplexity `reportLevel`. */
const DEFAULT_REPORT_LEVEL = "15";

/** A `<rule ref=".../CognitiveComplexity">`, or the whole design category without an exclude for it. */
function findRule(root: XmlEl): XmlEl | undefined {
  const rules = descendants(root, "rule");
  const direct = rules.find((r) => (r.attrs.ref ?? "").endsWith(`/${RULE}`));
  if (direct) return direct;
  return rules.find(
    (r) => r.attrs.ref === CATEGORY && !r.children.some((c) => c.name === "exclude" && c.attrs.name === RULE),
  );
}

function reportLevel(rule: XmlEl): XmlEl | undefined {
  const properties = child(rule, "properties");
  return properties?.children.find((p) => p.name === "property" && p.attrs.name === "reportLevel");
}

/** Checks the PMD ruleset of a Java component: CognitiveComplexity with reportLevel per the declaration. */
export async function checkPmd(t: JavaTarget): Promise<Finding[]> {
  const file = findConfig(t, PMD_FILES);
  if (!file) {
    return [
      finding(
        t,
        "error",
        "java/pmd-missing",
        `找不到 PMD 規則集（${PMD_FILES.join("、")}）`,
        generated(t, t.component.dir + PMD_FILES[0]),
      ),
    ];
  }
  const root = await readXmlConfig(t, file);
  if (isFinding(root)) return [root];
  const rule = findRule(root);
  if (!rule) {
    return [
      finding(t, "error", "java/pmd-rule-missing", `${file}：缺少 PMD 的 ${RULE}（complexity.cognitive）`, {
        file,
        ...generated(t, file),
      }),
    ];
  }
  const level = reportLevel(rule);
  const raw = level ? (level.attrs.value ?? child(level, "value")?.text ?? "") : DEFAULT_REPORT_LEVEL;
  return judgeNumber(t, "complexity.cognitive", raw, {
    file,
    line: (level ?? rule).line,
    setting: `${RULE} reportLevel`,
  });
}
