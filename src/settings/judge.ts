import { compareToDefault } from "../declaration/compare.ts";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import type { ItemDef, ItemValue, Standard } from "../standard/types.ts";

const fmt = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : JSON.stringify(v));

/**
 * Compares the values found in one component's tool config files with its declared (effective) standard
 * (SPEC §8): looser than declared is an error, stricter is a hint to sync the declaration,
 * and a style item that differs is an error because the declaration is the source of truth.
 */
export class SettingsJudge {
  readonly findings: Finding[] = [];
  private readonly defs: Readonly<Record<string, ItemDef>>;
  private readonly component: ResolvedComponent;

  constructor(standard: Standard, component: ResolvedComponent) {
    this.defs = standard.languages[component.language];
    this.component = component;
  }

  /** The declared value of an item, or undefined when the declaration made it invalid (already reported). */
  declared(key: string): unknown {
    const eff: EffectiveItem | undefined = this.component.effective[key];
    return eff && eff.status !== "invalid" ? eff.value : undefined;
  }

  /** Path of a file in this component's directory, repo-relative. */
  path(name: string): string {
    return this.component.dir + name;
  }

  private add(level: Finding["level"], rule: string, message: string, file: string, fix?: string): void {
    this.findings.push({ level, layer: "config", rule, message, component: this.component.name, file, fix });
  }

  /** Judges `actual` (read from `file`) against the declared value of `key`; `label` names the setting in the file. */
  compare(key: string, actual: unknown, file: string, label?: string): void {
    const item = this.defs[key];
    const declared = this.declared(key);
    if (!item || declared === undefined) return;
    const what = label ?? item.label;
    const status = compareToDefault({ ...item, value: declared as ItemValue }, actual);
    if (status === "same" || status === "alternative") return;
    if (status === "stricter") {
      this.add(
        "hint",
        "settings/stricter",
        `${what} 為 ${fmt(actual)}，比宣告的 ${fmt(declared)} 嚴格`,
        file,
        `建議把宣告中的 ${key} 同步成 ${fmt(actual)}`,
      );
      return;
    }
    const why = status === "looser" ? `比宣告的 ${fmt(declared)} 寬鬆` : `與宣告的 ${fmt(declared)} 不同`;
    this.add(
      "error",
      "settings/looser",
      `${what} 為 ${fmt(actual)}，${why}`,
      file,
      `把 ${file} 的 ${what} 改成宣告的值`,
    );
  }

  /** A setting that must be on is off (or absent from a config whose content is fully known). */
  disabled(key: string, file: string, label: string): void {
    if (this.declared(key) === undefined) return;
    this.add("error", "settings/looser", `${label} 沒有啟用`, file, `在 ${file} 啟用 ${label}`);
  }

  /** A lint rule with a numeric limit: off is looser; undefined means the config does not show it literally. */
  limit(key: string, rule: { enabled: boolean; max: number } | undefined, file: string, label: string): void {
    if (!rule) this.unconfirmed(file, ` ${label} 的設定`);
    else if (!rule.enabled) this.disabled(key, file, label);
    else this.compare(key, rule.max, file, `${label} 上限`);
  }

  /** The tool's config file is not there at all. */
  missingFile(file: string, what: string): void {
    this.add("error", "settings/missing-file", `找不到${what}`, file, `建立 ${file}`);
  }

  /** Part of a config that cannot be read reliably (code-form config, shared presets): say so instead of guessing. */
  unconfirmed(file: string, what: string): void {
    this.add("hint", "settings/unconfirmed", `無法從設定檔確認${what}，請自行確認`, file);
  }
}
