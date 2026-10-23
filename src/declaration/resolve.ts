import { CLI_INSTALL_HINT } from "../distribution.ts";
import type { Finding, Level } from "../report/finding.ts";
import { BUNDLED_STANDARDS, findStandard } from "../standard/registry.ts";
import { LANGUAGE_LABEL, LANGUAGES, type ItemDef, type Language, type Standard } from "../standard/types.ts";
import { compareToDefault, type Status } from "./compare.ts";
import { displayDir, normalizeDir } from "./path.ts";
import type { Declaration, RawOverride } from "./types.ts";
import { isRecord } from "../shared/guards.ts";

export interface EffectiveItem {
  value: unknown;
  source: "default" | "override";
  status: Status;
  reason?: string;
  /** Set on a looser override whose reason and until are valid: a deviation that is in force. */
  accepted?: boolean;
  until?: string;
}

/**
 * The value an item holds the component to: the declared one, unless it is invalid or a widening without a valid
 * reason (the declaration layer reports those), in which case the standard's own value. The one rule for every layer
 * that acts on a declared value (coverage threshold, tool version range, vulnerability threshold).
 */
export function valueInForce(standardValue: unknown, item: EffectiveItem | undefined): unknown {
  if (!item || item.status === "invalid") return standardValue;
  if (item.status === "looser" && item.accepted !== true) return standardValue;
  return item.value;
}

export interface ResolvedComponent {
  /** Normalized directory, "" for the repo root. */
  dir: string;
  language: Language;
  name: string;
  effective: Record<string, EffectiveItem>;
}

export interface Resolution {
  standard?: Standard;
  components: ResolvedComponent[];
  global: Record<string, EffectiveItem>;
  findings: Finding[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fmt = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : JSON.stringify(v));

interface Unwrapped {
  value: unknown;
  reason?: unknown;
  until?: unknown;
}

function unwrap(raw: unknown, item: ItemDef): Unwrapped {
  if (item.kind !== "ignoredVulns" && isRecord(raw) && "value" in raw) {
    return { value: raw.value, reason: raw.reason, until: raw.until };
  }
  return { value: raw };
}

class Resolver {
  readonly findings: Finding[] = [];
  private readonly file: string;
  private readonly today: string;

  constructor(file: string, today: string) {
    this.file = file;
    this.today = today;
  }

  add(level: Level, rule: string, message: string, extra: Partial<Finding> = {}): void {
    this.findings.push({ level, layer: "config", rule, message, file: this.file, ...extra });
  }

  /** Validates the reason/until pair of something looser than the standard. Returns true when it is a valid deviation. */
  private checkJustification(reason: unknown, until: unknown, what: string, at: Partial<Finding>): boolean {
    if (typeof reason !== "string" || reason.trim() === "") {
      this.add(
        "error",
        "declaration/looser-without-reason",
        `${what}：比預設寬鬆，必須寫理由（改用 {value, reason, until}）`,
        at,
      );
      return false;
    }
    if (reason.trimStart().startsWith("TODO")) {
      this.add("error", "declaration/todo-reason", `${what}：理由仍是 TODO，請填寫`, at);
      return false;
    }
    if (until !== undefined && (typeof until !== "string" || !DATE.test(until))) {
      this.add("error", "declaration/invalid-until", `${what}：until 必須是 YYYY-MM-DD 格式的日期`, at);
      return false;
    }
    if (typeof until === "string" && until < this.today) {
      this.add("error", "declaration/deviation-expired", `${what}：偏離已於 ${until} 到期，請收緊回預設或延長期限`, at);
      return false;
    }
    return true;
  }

  private judge(item: ItemDef, override: RawOverride, at: Partial<Finding>): EffectiveItem {
    const { value, reason, until } = unwrap(override.raw, item);
    const status = compareToDefault(item, value);
    const what = `${item.label}：${fmt(item.value)} → ${fmt(value)}`;
    const effective: EffectiveItem = {
      value,
      source: "override",
      status,
      reason: typeof reason === "string" ? reason : undefined,
      until: typeof until === "string" ? until : undefined,
    };
    if (status === "invalid") {
      this.add("error", "declaration/invalid-value", `${what}：值的型別或格式不對`, at);
    } else if (item.kind === "ignoredVulns") {
      this.judgeIgnoredVulns(value as unknown[], at);
    } else if (status === "looser") {
      if (this.checkJustification(reason, until, what, at)) {
        effective.accepted = true;
        const tail = typeof until === "string" ? `｜到期：${until}` : "｜未設到期日";
        this.add("deviation", "declaration/deviation", `${what}｜理由：${String(reason)}${tail}`, at);
      }
    } else if (reason !== undefined) {
      this.add("hint", "declaration/unneeded-reason", `${what}：沒有放寬，不需要寫理由`, at);
    }
    return effective;
  }

  private judgeIgnoredVulns(entries: unknown[], at: Partial<Finding>): void {
    entries.forEach((entry, i) => {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      if (!id || !isRecord(entry)) {
        this.add(
          "error",
          "declaration/invalid-value",
          `忽略的弱點第 ${String(i + 1)} 項：必須是包含 id、reason、until 的對應表`,
          at,
        );
        return;
      }
      const what = `忽略弱點 ${id}`;
      const { reason, until } = entry;
      if (until === undefined) {
        this.add("error", "declaration/ignored-vuln-without-until", `${what}：必須設定 until`, at);
      } else if (this.checkJustification(reason, until, what, at)) {
        // checkJustification only passes when both are strings
        this.add(
          "deviation",
          "declaration/deviation",
          `${what}｜理由：${reason as string}｜到期：${until as string}`,
          at,
        );
      }
    });
  }

  applyOverrides(defs: Readonly<Record<string, ItemDef>>, overrides: RawOverride[], where: string, component?: string) {
    const effective: Record<string, EffectiveItem> = {};
    for (const [key, item] of Object.entries(defs))
      effective[key] = { value: item.value, source: "default", status: "same" };
    for (const override of overrides) {
      const at: Partial<Finding> = { component, line: override.line };
      const item = defs[override.key];
      if (!item) {
        this.add("error", "declaration/unknown-item", `「${override.key}」不是${where}標準中的項目`, at);
        continue;
      }
      effective[override.key] = this.judge(item, override, at);
    }
    return effective;
  }
}

function checkStandardVersion(
  r: Resolver,
  decl: Declaration,
  today: string,
  bundled: readonly Standard[],
): Standard | undefined {
  const at = { line: decl.standardLine };
  const found = findStandard(decl.standard, bundled);
  if (!found.ok) {
    const messages = {
      malformed: `standard 必須寫成「名稱@x.y.z」的確切版本，目前是「${decl.standard}」`,
      "unknown-name": `這個 devguard 沒有內建「${decl.standard}」這套標準`,
      "newer-than-cli": `「${decl.standard}」比這個 devguard 內建的標準還新`,
      "no-longer-bundled": `這個 devguard 沒有內建「${decl.standard}」（可能已過舊或不存在）`,
    };
    const fixes = {
      malformed: undefined,
      "unknown-name": undefined,
      "newer-than-cli": `更新 devguard：${CLI_INSTALL_HINT}`,
      "no-longer-bundled": "devguard standard upgrade",
    };
    r.add("error", `standard/${found.reason}`, messages[found.reason], { ...at, fix: fixes[found.reason] });
    return undefined;
  }
  const dep = found.standard.deprecated;
  if (dep) {
    const level = dep.until < today ? "error" : "hint";
    r.add(level, "standard/deprecated", `「${decl.standard}」已棄用，請在 ${dep.until} 前升級`, {
      ...at,
      fix: "devguard standard upgrade",
    });
  }
  return found.standard;
}

function isLanguage(v: string): v is Language {
  return (LANGUAGES as readonly string[]).includes(v);
}

function hintStyleDrift(r: Resolver, standard: Standard, components: ResolvedComponent[]): void {
  for (const language of LANGUAGES) {
    const same = components.filter((c) => c.language === language);
    if (same.length < 2) continue;
    for (const [key, item] of Object.entries(standard.languages[language])) {
      if (item.kind !== "style") continue;
      const values = new Set(same.map((c) => JSON.stringify(c.effective[key]?.value)));
      if (values.size > 1) {
        r.add(
          "hint",
          "declaration/style-inconsistent",
          `${LANGUAGE_LABEL[language]} 元件之間的「${item.label}」不一致`,
        );
      }
    }
  }
}

/** Default standard + declaration → effective standard per component, plus findings (SPEC §4). */
export function resolveDeclaration(
  decl: Declaration,
  today: string,
  bundled: readonly Standard[] = BUNDLED_STANDARDS,
): Resolution {
  const r = new Resolver(decl.file, today);
  const standard = checkStandardVersion(r, decl, today, bundled);
  if (!standard) return { components: [], global: {}, findings: r.findings };

  const seen = new Set<string>();
  const components: ResolvedComponent[] = [];
  for (const c of decl.components) {
    const dir = normalizeDir(c.path);
    const name = `${displayDir(dir)} (${isLanguage(c.language) ? LANGUAGE_LABEL[c.language] : c.language})`;
    if (!isLanguage(c.language)) {
      r.add(
        "error",
        "declaration/unknown-language",
        `${name}：不支援的語言「${c.language}」，可用的有 ${LANGUAGES.join("、")}`,
        { line: c.line },
      );
      continue;
    }
    if (seen.has(`${dir}|${c.language}`))
      r.add("error", "declaration/duplicate-component", `${name}：重複宣告同一個元件`, { line: c.line });
    seen.add(`${dir}|${c.language}`);
    const effective = r.applyOverrides(
      standard.languages[c.language],
      c.overrides,
      ` ${LANGUAGE_LABEL[c.language]} `,
      name,
    );
    components.push({ dir, language: c.language, name, effective });
  }
  hintStyleDrift(r, standard, components);
  const global = r.applyOverrides(standard.global, decl.globalOverrides, "整體");
  return { standard, components, global, findings: r.findings };
}
