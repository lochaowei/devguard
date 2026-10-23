import { compareVersion } from "../standard/registry.ts";

/**
 * Tool version ranges (SPEC §4.2 「版本範圍」, §5.2): comma-separated clauses such as `>=0.17,<0.18`.
 * Operators: `>=`, `>`, `<=`, `<`, `==`; a bare version means `==`. Versions compare numerically by
 * their dotted prefix, so `v2.13.1` and `1.2.3-rc1` are read as `2.13.1` and `1.2.3`.
 */

interface Bound {
  version: number[];
  inclusive: boolean;
}

/** The set of versions a range admits, as one interval. A missing bound is unbounded. */
export interface Range {
  lower?: Bound;
  upper?: Bound;
}

const CLAUSE = /^(>=|<=|==|>|<|=)?\s*v?(\d+(?:\.\d+)*)$/;
const VERSION = /^v?(\d+(?:\.\d+)*)/;

/** The numeric parts of a version string, or undefined when it does not start with a dotted number. */
export function parseVersion(text: string): number[] | undefined {
  const m = VERSION.exec(text.trim());
  return m?.[1]?.split(".").map(Number);
}

/** Compares two bounds of the same side; positive when `a` admits less than `b` on that side. */
function tighter(a: Bound | undefined, b: Bound | undefined, side: "lower" | "upper"): number {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  const d = compareVersion(a.version, b.version);
  if (d !== 0) return side === "lower" ? d : -d;
  return (a.inclusive ? 0 : 1) - (b.inclusive ? 0 : 1);
}

function isEmpty({ lower, upper }: Range): boolean {
  if (!lower || !upper) return false;
  const d = compareVersion(lower.version, upper.version);
  return d > 0 || (d === 0 && !(lower.inclusive && upper.inclusive));
}

/** Parses a range; undefined when it is malformed or admits no version. */
export function parseRange(text: string): Range | undefined {
  const range: Range = {};
  for (const clause of text.split(",")) {
    if (!narrow(range, clause.trim())) return undefined;
  }
  return isEmpty(range) ? undefined : range;
}

/** Intersects `range` with one clause; false when the clause is malformed. */
function narrow(range: Range, clause: string): boolean {
  const m = CLAUSE.exec(clause);
  if (!m?.[2]) return false;
  const op = m[1] ?? "==";
  const bound: Bound = { version: m[2].split(".").map(Number), inclusive: op !== ">" && op !== "<" };
  const sets = { lower: !op.startsWith("<"), upper: !op.startsWith(">") };
  if (sets.lower && tighter(bound, range.lower, "lower") > 0) range.lower = bound;
  if (sets.upper && tighter(bound, range.upper, "upper") > 0) range.upper = bound;
  return true;
}

/** Whether `version` falls inside `range`. False when either cannot be parsed. */
export function inRange(version: string, range: string | Range): boolean {
  const r = typeof range === "string" ? parseRange(range) : range;
  const v = parseVersion(version);
  if (!r || !v) return false;
  const point: Bound = { version: v, inclusive: true };
  return tighter(point, r.lower, "lower") >= 0 && tighter(point, r.upper, "upper") >= 0;
}

/** -1 when `a` admits strictly fewer versions than `b`, 0 when equal, 1 when `a` admits a version `b` does not. */
export function compareRanges(a: Range, b: Range): -1 | 0 | 1 {
  const lower = tighter(a.lower, b.lower, "lower");
  const upper = tighter(a.upper, b.upper, "upper");
  if (lower < 0 || upper < 0) return 1;
  return lower === 0 && upper === 0 ? 0 : -1;
}
