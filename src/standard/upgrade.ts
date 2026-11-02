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
  /** A choice item kept in both versions whose alternatives changed, e.g. `typecheck.tool` allowing basedpyright. */
  allowed?: { added: string[]; removed: string[] };
}

/** How a choice item's allowed values changed; undefined when they did not. */
function allowedChange(a: ItemDef, b: ItemDef): ItemChange["allowed"] {
  const before = a.allowed ?? [];
  const after = b.allowed ?? [];
  const added = after.filter((v) => !before.includes(v));
  const removed = before.filter((v) => !after.includes(v));
  return added.length > 0 || removed.length > 0 ? { added, removed } : undefined;
}

/** How one item changed between two versions; undefined when its value and allowed values stay. */
function diffItem(scope: ItemChange["scope"], key: string, a?: ItemDef, b?: ItemDef): ItemChange | undefined {
  if (!b) return a && { scope, key, label: a.label, before: a.value };
  if (!a) return { scope, key, label: b.label, after: b.value };
  const allowed = allowedChange(a, b);
  if (!allowed && JSON.stringify(a.value) === JSON.stringify(b.value)) return undefined;
  return { scope, key, label: b.label, before: a.value, after: b.value, ...(allowed ? { allowed } : {}) };
}

function diffItems(
  scope: ItemChange["scope"],
  from: Readonly<Record<string, ItemDef>>,
  to: Readonly<Record<string, ItemDef>>,
): ItemChange[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap(
    (key) => diffItem(scope, key, from[key], to[key]) ?? [],
  );
}

/**
 * The standard items whose values (or, for a choice, allowed values) differ between `from` and `to`: the global ones
 * and those of `languages`.
 */
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
 * What `standard upgrade` may move `id` to, the default first: newer bundled versions of the same standard (newest
 * first), then the version its `upgradesTo` names and that standard's newer versions (oldest first). Without
 * `upgradesTo` (team) only the same standard's versions are targets, so team never moves to legacy.
 */
export function upgradeTargets(id: string, bundled: readonly Standard[]): Standard[] {
  const own = newerVersions(id, bundled);
  const next = bundled.find((s) => s.id === id)?.upgradesTo;
  const step = next === undefined ? undefined : bundled.find((s) => s.id === next);
  if (!step) return own;
  return [...own, step, ...newerVersions(step.id, bundled).reverse()];
}

/**
 * The hint `doctor` gives when this CLI bundles a minor or patch update of the declared standard (SPEC §5.5;
 * `src/environment/standard-upgrade.ts`). Undefined when there is none, or the id is malformed or unknown.
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
