import { findFirst, propertyValueIndex } from "../config-files.ts";
import type { SettingsJudge } from "../judge.ts";

const FLAT_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `eslint.config.${ext}`);

const STRICT_PRESET = "typescript-eslint/strictTypeChecked";

/** Rules with a numeric limit, and the limit ESLint uses when the rule is on without options. */
const LIMIT_RULES = [
  { key: "complexity.cyclomatic", rule: "complexity", option: /^(\d+)|\bmax(?:imum)?\s*:\s*(\d+)/, fallback: 20 },
  {
    key: "complexity.cognitive",
    rule: "sonarjs/cognitive-complexity",
    option: /^(\d+)/,
    fallback: 15,
  },
] as const;

/** A rule's state when its entry is written as literals; undefined when it is absent or not literal. */
export interface RuleLimit {
  enabled: boolean;
  max: number;
}

const SEVERITY = /^\s*(?:"(\w+)"|'(\w+)'|(\d))\s*,?\s*/;

/** The limit in a rule's options text (after the severity); the fallback when there are no options. */
function readLimit(options: string, option: RegExp, fallback: number): RuleLimit | undefined {
  if (options.trim() === "") return { enabled: true, max: fallback };
  const max = option.exec(options)?.slice(1).find(Boolean);
  return max === undefined ? undefined : { enabled: true, max: Number(max) };
}

/** Reads `rule: severity` or `rule: [severity, options]` from flat config source text. */
function readRule(text: string, rule: string, option: RegExp, fallback: number): RuleLimit | undefined {
  const start = propertyValueIndex(text, rule);
  if (start === undefined) return undefined;
  const rest = text.slice(start);
  const isArray = rest.startsWith("[");
  const entry = isArray ? rest.slice(1, Math.max(rest.indexOf("]"), 1)) : rest;
  const severity = SEVERITY.exec(entry);
  if (!severity) return undefined;
  const level = severity.slice(1).find(Boolean);
  if (level === "off" || level === "0") return { enabled: false, max: fallback };
  return readLimit(isArray ? entry.slice(severity[0].length) : "", option, fallback);
}

function checkPreset(text: string, file: string, judge: SettingsJudge): void {
  const rules = judge.declared("lint.rules");
  if (!Array.isArray(rules) || !rules.includes(STRICT_PRESET)) return;
  if (/\bstrictTypeChecked(?:Only)?\b/.test(text)) return;
  if (/\bconfigs\s*\.\s*(?:recommended|strict|stylistic)\w*/.test(text)) {
    judge.disabled("lint.rules", file, "typescript-eslint strictTypeChecked（目前用的是較寬鬆的組合）");
  } else {
    judge.unconfirmed(file, "已套用 typescript-eslint strictTypeChecked");
  }
}

/** `lint.rules` (strictTypeChecked) and the complexity limits against the ESLint flat config. */
export async function checkEslint(root: string, judge: SettingsJudge): Promise<void> {
  const found = await findFirst(root, FLAT_CONFIGS);
  if (!found) {
    judge.missingFile(judge.path("eslint.config.js"), " ESLint flat config（eslint.config.*）");
    return;
  }
  const file = judge.path(found.name);
  checkPreset(found.text, file, judge);
  for (const { key, rule, option, fallback } of LIMIT_RULES) {
    judge.limit(key, readRule(found.text, rule, option, fallback), file, `ESLint ${rule}`);
  }
}
