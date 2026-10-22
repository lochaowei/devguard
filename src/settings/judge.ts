import { compareToDefault } from "../declaration/compare.ts";
import type { EffectiveItem } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import type { ItemDef } from "../standard/types.ts";

/** Where a value read from a tool config file came from. */
export interface ConfigSite {
  component: string;
  /** Repo-relative path of the config file. */
  file: string;
  line?: number;
}

const fmt = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : JSON.stringify(v));

/**
 * Compares a value read from a tool config file with the component's declared (effective) value (SPEC §8):
 * looser than declared is an error that `fix` resets, stricter is a hint to sync the declaration.
 * Returns nothing when they match or the value cannot be judged.
 */
export function judgeConfigValue(
  key: string,
  item: ItemDef,
  declared: EffectiveItem | undefined,
  actual: unknown,
  site: ConfigSite,
): Finding | undefined {
  const want = declared?.value ?? item.value;
  const status = compareToDefault({ ...item, value: want as ItemDef["value"] }, actual);
  const what = `${site.file}：${item.label} 實際為 ${fmt(actual)}`;
  if (status === "looser") {
    return {
      level: "error",
      layer: "config",
      rule: "settings/looser-than-declared",
      message: `${what}，比宣告的 ${fmt(want)} 寬鬆`,
      ...site,
      fix: `devguard fix（改回宣告的 ${fmt(want)}）`,
    };
  }
  if (status === "stricter") {
    return {
      level: "hint",
      layer: "config",
      rule: "settings/stricter-than-declared",
      message: `${what}，比宣告的 ${fmt(want)} 嚴格`,
      ...site,
      fix: `建議在 .devguard.yaml 把 ${key} 同步成 ${fmt(actual)}`,
    };
  }
  return undefined;
}
