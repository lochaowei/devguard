import { compareVersion } from "../standard/registry.ts";
import { SEVERITIES, type ItemDef } from "../standard/types.ts";
import { compareRanges, parseRange } from "../versions/range.ts";

/**
 * How an overriding value relates to the default.
 * - "alternative": a choice from the allowed list; not a deviation
 * - "different": a style item set to another value; not a deviation
 */
export type Status = "same" | "stricter" | "looser" | "alternative" | "different" | "invalid";

const VERSION = /^\d+(\.\d+)*$/;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function byOrder(diff: number, lowerIsStricter: boolean): Status {
  if (diff === 0) return "same";
  return diff < 0 === lowerIsStricter ? "stricter" : "looser";
}

function compareList(def: string[], value: unknown): Status {
  if (!isStringArray(value)) return "invalid";
  if (def.some((x) => !value.includes(x))) return "looser";
  return new Set(value).size > new Set(def).size ? "stricter" : "same";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isStringArray(a) && isStringArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

function compareStyle(def: unknown, value: unknown): Status {
  const shape = (v: unknown): string => (isStringArray(v) ? "string[]" : typeof v);
  if (shape(def) !== shape(value)) return "invalid";
  return sameValue(def, value) ? "same" : "different";
}

/** The scheme and host (with port) of a URL; undefined when it is not one. */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Another repository on the default mirror's host is a style change; anywhere else is looser (SPEC §4.2, §10.2). */
function compareMirror(item: ItemDef, value: unknown): Status {
  if (typeof value !== "string" || typeof item.value !== "string") return "invalid";
  // An empty mirror points nowhere: the checks that need it report it missing.
  if (value.trim() === "") return "different";
  if (hostOf(value) === undefined) return "invalid";
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  if (norm(value) === norm(item.value)) return "same";
  return hostOf(value) === hostOf(item.value) ? "different" : "looser";
}

function compareChoice(item: ItemDef, value: unknown): Status {
  if (typeof value !== "string") return "invalid";
  if (value === item.value) return "same";
  return item.allowed?.includes(value) ? "alternative" : "looser";
}

function compareNumber(item: ItemDef, value: unknown): Status {
  if (typeof value !== "number" || typeof item.value !== "number") return "invalid";
  return byOrder(value - item.value, item.kind === "max");
}

function compareMinVersion(item: ItemDef, value: unknown): Status {
  const def = item.value;
  if (typeof value !== "string" || !VERSION.test(value) || typeof def !== "string") return "invalid";
  return byOrder(compareVersion(value.split(".").map(Number), def.split(".").map(Number)), false);
}

function compareVersionRange(item: ItemDef, value: unknown): Status {
  const def = typeof item.value === "string" ? parseRange(item.value) : undefined;
  const range = typeof value === "string" ? parseRange(value) : undefined;
  if (!def || !range) return "invalid";
  const order = compareRanges(range, def);
  return order === 0 ? "same" : order < 0 ? "stricter" : "looser";
}

function compareBool(item: ItemDef, value: unknown): Status {
  if (typeof value !== "boolean") return "invalid";
  if (value === item.value) return "same";
  return value ? "stricter" : "looser";
}

function compareSeverity(item: ItemDef, value: unknown): Status {
  const levels: readonly unknown[] = SEVERITIES;
  const at = levels.indexOf(value);
  return at < 0 ? "invalid" : byOrder(at - levels.indexOf(item.value), true);
}

function compareIgnoredVulns(_item: ItemDef, value: unknown): Status {
  if (!Array.isArray(value)) return "invalid";
  return value.length === 0 ? "same" : "looser";
}

const COMPARERS: Record<ItemDef["kind"], (item: ItemDef, value: unknown) => Status> = {
  max: compareNumber,
  min: compareNumber,
  minVersion: compareMinVersion,
  versionRange: compareVersionRange,
  bool: compareBool,
  severity: compareSeverity,
  list: (item, value) => compareList(item.value as string[], value),
  choice: compareChoice,
  style: (item, value) => compareStyle(item.value, value),
  mirror: compareMirror,
  ignoredVulns: compareIgnoredVulns,
};

/** Judges `value` against the item's default, per the item's kind (SPEC §4.2). */
export function compareToDefault(item: ItemDef, value: unknown): Status {
  return COMPARERS[item.kind](item, value);
}
