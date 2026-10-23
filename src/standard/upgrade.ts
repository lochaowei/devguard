import { DECLARATION_FILE } from "../declaration/types.ts";
import type { Finding } from "../report/finding.ts";
import { BUNDLED_STANDARDS, compareVersion, parseStandardId } from "./registry.ts";
import type { ItemDef, ItemValue, Language, Standard } from "./types.ts";

/** One standard item that differs between two versions; `before` / `after` absent when it is added / removed. */
export interface ItemChange {
  scope: "global" | Language;
  key: string;
  label: string;
  before?: ItemValue;
  after?: ItemValue;
}

function diffItems(
  scope: ItemChange["scope"],
  from: Readonly<Record<string, ItemDef>>,
  to: Readonly<Record<string, ItemDef>>,
): ItemChange[] {
  const changes: ItemChange[] = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = from[key];
    const b = to[key];
    if (a && b && JSON.stringify(a.value) === JSON.stringify(b.value)) continue;
    const label = (b ?? a)?.label ?? key;
    changes.push({ scope, key, label, ...(a ? { before: a.value } : {}), ...(b ? { after: b.value } : {}) });
  }
  return changes;
}

/** The standard items whose values differ between `from` and `to`: the global ones and those of `languages`. */
export function diffStandards(from: Standard, to: Standard, languages: readonly Language[]): ItemChange[] {
  return [
    ...diffItems("global", from.global, to.global),
    ...[...new Set(languages)].flatMap((l) => diffItems(l, from.languages[l], to.languages[l])),
  ];
}

/** Bundled versions of the same standard as `id`, newest first. */
export function newerVersions(id: string, bundled: readonly Standard[]): Standard[] {
  const current = parseStandardId(id);
  if (!current) return [];
  return bundled
    .map((standard) => ({ standard, parsed: parseStandardId(standard.id) }))
    .filter(({ parsed }) => parsed?.name === current.name && compareVersion(parsed.version, current.version) > 0)
    .sort((a, b) => compareVersion(b.parsed?.version ?? [], a.parsed?.version ?? []))
    .map(({ standard }) => standard);
}

/**
 * The hint `doctor` gives when this CLI bundles a minor or patch update of the declared standard (SPEC §5.5). Until
 * `doctor` exists (#21) `check` reports it. Undefined when there is none, or the id is malformed or unknown.
 */
export function upgradeSuggestion(id: string, bundled: readonly Standard[] = BUNDLED_STANDARDS): Finding | undefined {
  const major = parseStandardId(id)?.version[0];
  const newest = newerVersions(id, bundled).find((s) => parseStandardId(s.id)?.version[0] === major);
  if (!newest) return undefined;
  return {
    level: "hint",
    layer: "config",
    rule: "standard/upgrade-available",
    message: `標準有不影響現有專案的更新：${id} → ${newest.id}`,
    file: DECLARATION_FILE,
    fix: `devguard standard upgrade ${newest.id}`,
  };
}
