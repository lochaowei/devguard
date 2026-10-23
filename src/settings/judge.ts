import { compareToDefault } from "../declaration/compare.ts";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { KeyPath, Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";
import type { ItemDef, ItemValue, Standard } from "../standard/types.ts";

/** Where a value read from a tool config file came from. */
export interface ConfigSite {
  component: string;
  /** Repo-relative path of the config file. */
  file: string;
  line?: number;
}

/** Builds the repairs that put the declared value back, from that value. */
export type RepairFor = (want: unknown) => Repair[];

/** The repair that sets the key at `path` of `file` to the declared value (or to `map(declared)`). */
export const setAt =
  (file: string, path: KeyPath, map: (want: unknown) => unknown = (w) => w): RepairFor =>
  (want) => [{ op: "set", file, path, value: map(want) }];

const fmt = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : JSON.stringify(v));

/**
 * Compares a value read from a tool config file with the component's declared (effective) value (SPEC §8):
 * looser than declared is an error that `fix` resets, stricter is a hint to sync the declaration, and a style
 * item that differs is an error because the declaration is the source of truth.
 * Without a declaration entry the standard's default is the declared value; an invalid declaration (already
 * reported) and an unjudgeable value give nothing. `label` names the setting in the file (default: the item's label).
 * `repair` says how to put the declared value back; whether `devguard fix` writes it or only prints it follows the
 * file's category (SPEC §9.2).
 */
export function judgeConfigValue(
  key: string,
  item: ItemDef,
  declared: EffectiveItem | undefined,
  actual: unknown,
  site: ConfigSite,
  label: string = item.label,
  repair?: RepairFor,
): Finding | undefined {
  if (declared?.status === "invalid") return undefined;
  const want = declared?.value ?? item.value;
  const status = compareToDefault({ ...item, value: want as ItemValue }, actual);
  const what = `${label} 為 ${fmt(actual)}`;
  if (status === "stricter") return stricterHint(key, `${what}，比宣告的 ${fmt(want)} 嚴格`, actual, site);
  if (status !== "looser" && status !== "different") return undefined;
  const why = status === "looser" ? `比宣告的 ${fmt(want)} 寬鬆` : `與宣告的 ${fmt(want)} 不同`;
  const observed = { key, value: actual };
  return withRepairs(
    { level: "error", layer: "config", rule: "settings/looser", message: `${what}，${why}`, ...site, observed },
    `把 ${site.file} 的 ${label} 改回宣告的 ${fmt(want)}`,
    repair,
    want,
  );
}

/** A config value stricter than declared: a hint to sync the declaration (SPEC §8). */
function stricterHint(key: string, message: string, actual: unknown, site: ConfigSite): Finding {
  const fix = `建議把宣告中的 ${key} 同步成 ${fmt(actual)}`;
  const observed = { key, value: actual };
  return { level: "hint", layer: "config", rule: "settings/stricter", message, ...site, fix, observed };
}

/** A finding with its repairs and the matching fix text (SPEC §9.2: fix writes it, or only prints it). */
function withRepairs(finding: Finding, detail: string, repair: RepairFor | undefined, want: unknown): Finding {
  const repairs = repair?.(want) ?? [];
  return { ...finding, fix: fixText(detail, repairs), ...(repairs.length > 0 ? { repairs } : {}) };
}

/**
 * Collects the findings for one component's tool config files against its declared standard (SPEC §8).
 * Value comparisons go through `judgeConfigValue`; the other methods cover settings that are off, files that
 * are missing and config that cannot be read reliably.
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

  /** Normalized directory of this component (`""` or ending in `"/"`). */
  get dir(): string {
    return this.component.dir;
  }

  /** Path of a file in this component's directory, repo-relative. */
  path(name: string): string {
    return this.component.dir + name;
  }

  private add(finding: Omit<Finding, "layer" | "component">): void {
    this.findings.push({ ...finding, layer: "config", component: this.component.name });
  }

  /** Judges `actual` (read from `file`) against the declared value of `key`; `label` names the setting in the file. */
  compare(key: string, actual: unknown, file: string, label?: string, repair?: RepairFor): void {
    const item = this.defs[key];
    if (!item || this.declared(key) === undefined) return;
    const site = { component: this.component.name, file };
    const finding = judgeConfigValue(key, item, this.component.effective[key], actual, site, label, repair);
    if (finding) this.findings.push(finding);
  }

  /** A setting that must be on is off (or absent from a config whose content is fully known). */
  disabled(key: string, file: string, label: string, repair?: RepairFor): void {
    const want = this.declared(key);
    if (want === undefined) return;
    const finding: Finding = { level: "error", layer: "config", rule: "settings/looser", message: `${label} 沒有啟用` };
    const located = { ...finding, component: this.component.name, file };
    this.findings.push(withRepairs(located, `在 ${file} 啟用 ${label}`, repair, want));
  }

  /** A lint rule with a numeric limit: off is looser; undefined means the config does not show it literally. */
  limit(
    key: string,
    rule: { enabled: boolean; max: number } | undefined,
    file: string,
    label: string,
    repair?: RepairFor,
  ): void {
    if (!rule) this.unconfirmed(file, ` ${label} 的設定`);
    else if (!rule.enabled) this.disabled(key, file, label, repair);
    else this.compare(key, rule.max, file, `${label} 上限`, repair);
  }

  /** The tool's config file is not there at all. */
  missingFile(file: string, what: string, repairs: readonly Repair[] = []): void {
    const fix = fixText(`建立 ${file}`, repairs);
    this.add({
      level: "error",
      rule: "settings/missing-file",
      message: `找不到${what}`,
      file,
      fix,
      ...(repairs.length > 0 ? { repairs: [...repairs] } : {}),
    });
  }

  /** Part of a config that cannot be read reliably (code-form config, shared presets): say so instead of guessing. */
  unconfirmed(file: string, what: string): void {
    this.add({ level: "hint", rule: "settings/unconfirmed", message: `無法從設定檔確認${what}，請自行確認`, file });
  }
}
