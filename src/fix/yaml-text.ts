import { isDeepStrictEqual } from "node:util";
import { parse, type Document } from "yaml";

const squash = (line: string) => line.replace(/\s+/g, "");

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

/**
 * `out` with each line that the longest common subsequence pairs with an `original` line differing only in
 * whitespace put back to the original line.
 */
function restoreWhitespace(original: readonly string[], out: readonly string[]): string[] {
  const a = original.map(squash);
  const b = out.map(squash);
  const lcs = lcsLengths(a, b);
  const kept = [...out];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) kept[j++] = original[i++] ?? "";
    else if (lcs(i + 1, j) >= lcs(i, j + 1)) i++;
    else j++;
  }
  return kept;
}

/**
 * An edited YAML document as text that keeps the layout of the lines the edit did not touch (SPEC §9.2, #87). The
 * `yaml` package re-renders the whole document: it pads flow collections (`[a]` → `[ a ]`, turned off here so new
 * nodes are unpadded) and puts one space before a line comment. Every output line that differs from a line of
 * `original` only in whitespace is put back to that line, unless that would change a value.
 */
export function yamlText(doc: Document, original: string): string {
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const kept = restoreWhitespace(original.split("\n"), out.split("\n")).join("\n");
  return kept === out || !isDeepStrictEqual(parse(kept), parse(out)) ? out : kept;
}
