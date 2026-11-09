import { isDeepStrictEqual } from "node:util";
import { parse, type Document } from "yaml";

const squash = (line: string) => line.replace(/\s+/g, "");

/** Above this many cells (lines × lines) the changed middle of a file is not aligned, to bound time and memory. */
const MAX_TABLE = 4_000_000;

/** `lcs(i, j)`: the length of the longest common subsequence of `a[i..]` and `b[j..]`. */
function lcsLengths(a: readonly string[], b: readonly string[]): (i: number, j: number) => number {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  return lcs;
}

/** Pairs `[j, i]` of `b[j]` with an equal `a[i]`, in order: the longest common subsequence of `a` and `b`. */
function alignedPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const pairs: [number, number][] = [];
  for (let k = 0; k < start; k++) pairs.push([k, k]);
  const middle = middlePairs(a.slice(start, a.length - end), b.slice(start, b.length - end));
  for (const [j, i] of middle) pairs.push([start + j, start + i]);
  for (let k = end; k > 0; k--) pairs.push([b.length - k, a.length - k]);
  return pairs;
}

/** `alignedPairs` for the part between the common prefix and suffix; none when it is too large to align. */
function middlePairs(a: readonly string[], b: readonly string[]): [number, number][] {
  if (a.length * b.length > MAX_TABLE) return [];
  const lcs = lcsLengths(a, b);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) pairs.push([j++, i++]);
    else if (lcs(i + 1, j) >= lcs(i, j + 1)) i++;
    else j++;
  }
  return pairs;
}

const parsesTo = (text: string, value: unknown): boolean => {
  try {
    return isDeepStrictEqual(parse(text), value);
  } catch {
    return false;
  }
};

/**
 * An edited YAML document as text that keeps the layout of the lines the edit did not touch (SPEC §9.2, #87). The
 * `yaml` package re-renders the whole document: it pads flow collections (`[a]` → `[ a ]`, turned off here so new
 * nodes are unpadded) and puts one space before a line comment. Each output line that differs from its aligned line
 * of `original` only in whitespace is put back to that line, unless that would change a value. The text uses LF.
 */
export function renderKeepingLayout(doc: Document, original: string): string {
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const lines = out.split("\n");
  const before = original.split(/\r?\n/);
  const restores = alignedPairs(before.map(squash), lines.map(squash)).filter(([j, i]) => lines[j] !== before[i]);
  if (restores.length === 0) return out;
  const value: unknown = parse(out);
  const apply = (chosen: readonly [number, number][]) => {
    const text = [...lines];
    for (const [j, i] of chosen) text[j] = before[i] ?? "";
    return text.join("\n");
  };
  const all = apply(restores);
  if (parsesTo(all, value)) return all;
  // Some line's whitespace is part of a value: put back the others, one at a time.
  const kept: [number, number][] = [];
  for (const r of restores) if (parsesTo(apply([...kept, r]), value)) kept.push(r);
  return apply(kept);
}
