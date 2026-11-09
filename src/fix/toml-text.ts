import { parse as parseToml } from "@decimalturn/toml-patch";
import type { KeyPath } from "./repair.ts";

/**
 * Text-level TOML edits that a parse/patch round trip cannot express without losing layout: renaming a key in place
 * and moving array items together with their trailing comments (#111). Keys are found by scanning lines, following
 * `[table]` headers and dotted keys; values are skipped with a small scanner that knows strings, comments and brackets.
 */

const SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const KEY_LINE = new RegExp(String.raw`^([ \t]*)(${SEGMENT}(?:[ \t]*\.[ \t]*${SEGMENT})*)([ \t]*=[ \t]*)`);
const HEADER_LINE = new RegExp(
  String.raw`^[ \t]*\[\[?[ \t]*(${SEGMENT}(?:[ \t]*\.[ \t]*${SEGMENT})*)[ \t]*\]\]?[ \t]*(?:#.*)?$`,
);

const segments = (key: string): string[] =>
  [...key.matchAll(new RegExp(SEGMENT, "g"))].map((m) => {
    const s = m[0];
    return s.startsWith('"') ? (JSON.parse(s) as string) : s.startsWith("'") ? s.slice(1, -1) : s;
  });

/** Where a string literal opening at `i` ends (the index after its closing quote). */
function stringEnd(text: string, i: number): number {
  const quote = text[i] ?? '"';
  const triple = quote.repeat(3);
  if (text.startsWith(triple, i)) {
    const close = text.indexOf(triple, i + 3);
    return close < 0 ? text.length : close + 3;
  }
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== "\n") j += quote === '"' && text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The offset after the string at `i`, or (inside brackets) the end of the comment line at `i`, else the next one. */
function stepOver(text: string, i: number): number {
  const c = text[i];
  if (c === '"' || c === "'") return stringEnd(text, i);
  if (c !== "#") return i + 1;
  const newline = text.indexOf("\n", i);
  return newline < 0 ? text.length : newline;
}

/** Where the value starting at `from` ends: after its closing bracket, or before a trailing comment / the line end. */
function valueEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (depth === 0 && (c === "#" || c === "\n")) break;
    const delta = BRACKET[c] ?? 0;
    depth += delta;
    if (delta < 0 && depth === 0) return i + 1;
    i = stepOver(text, i);
  }
  return text.slice(from, i).trimEnd().length + from;
}

const BRACKET: Record<string, number> = { "[": 1, "{": 1, "]": -1, "}": -1 };

interface Located {
  /** Offset of the start of the key's line, and of the end of its line (before the newline). */
  lineStart: number;
  lineEnd: number;
  /** The last key segment's span (`extend-select` in `lint.extend-select`). */
  nameStart: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
}

const sameKey = (a: readonly (string | number)[], b: readonly (string | number)[]): boolean =>
  a.length === b.length && a.every((s, i) => String(s) === String(b[i]));

/** The key written on the line starting at `pos`, with where its value ends; undefined for other lines. */
function keyAt(text: string, pos: number, line: string): { dotted: string; located: Located } | undefined {
  const [whole = "", indent = "", dotted = ""] = KEY_LINE.exec(line) ?? [];
  if (whole === "") return undefined;
  const valueStart = pos + whole.length;
  const end = valueEnd(text, valueStart);
  const newline = text.indexOf("\n", end);
  const nameEnd = pos + indent.length + dotted.length;
  const name = new RegExp(`${SEGMENT}$`).exec(dotted)?.[0] ?? dotted;
  const located = {
    lineStart: pos,
    lineEnd: newline < 0 ? text.length : newline,
    nameStart: nameEnd - name.length,
    nameEnd,
    valueStart,
    valueEnd: end,
  };
  return { dotted, located };
}

function locate(text: string, path: KeyPath): Located | undefined {
  let header: string[] = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const line = text.slice(pos, nl < 0 ? text.length : nl);
    const head = HEADER_LINE.exec(line)?.[1];
    const key = head ? undefined : keyAt(text, pos, line);
    if (head) header = segments(head);
    if (key && sameKey([...header, ...segments(key.dotted)], path)) return key.located;
    pos = (key ? key.located.lineEnd : nl < 0 ? text.length : nl) + 1;
  }
  return undefined;
}

/** Renames the last segment of the key at `path` where it is written; the value and its layout stay as they are. */
export function renameKey(text: string, path: KeyPath, to: string): string {
  const at = locate(text, path);
  if (!at) throw new Error(`找不到 ${path.join(".")}`);
  const name = /^[A-Za-z0-9_-]+$/.test(to) ? to : JSON.stringify(to);
  return text.slice(0, at.nameStart) + name + text.slice(at.nameEnd);
}

interface Item {
  value: unknown;
  raw: string;
  /** Offset of the end of the raw item in the text, and its same-line comment (`# ...`) when it has one. */
  end: number;
  comment?: string;
}

/** The string items of the array whose `[` is at `open`, each with the comment after it on the same line. */
function itemsOf(text: string, open: number, close: number): Item[] {
  const items: Item[] = [];
  let i = open + 1;
  while (i < close) {
    const c = text[i];
    if (c === "#") i = text.indexOf("\n", i) < 0 ? close : text.indexOf("\n", i);
    else if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      const raw = text.slice(i, end);
      const rest = /^[ \t]*,?[ \t]*(#[^\n]*)?/.exec(text.slice(end));
      const comment = rest?.[1]?.trimEnd();
      items.push({ value: (parseToml(`k = ${raw}`) as { k: unknown }).k, raw, end, ...(comment ? { comment } : {}) });
      i = end;
    } else i++;
  }
  return items;
}

interface Splice {
  at: number;
  remove: number;
  insert: string;
}

/** The splice that appends `added` to the array at `dst`, in its layout: one per line, or inline. */
function appendTo(text: string, dst: Located, added: readonly Item[]): Splice[] {
  const open = dst.valueStart;
  const close = dst.valueEnd - 1;
  const items = itemsOf(text, open, close);
  const last = items.at(-1);
  const lastLineEnd = last ? (text.indexOf("\n", last.end) < 0 ? text.length : text.indexOf("\n", last.end)) : close;
  const multiline = last !== undefined && lastLineEnd < close && text.slice(open, close).includes("\n");
  if (!multiline) {
    const raws = added.map((a) => a.raw).join(", ");
    if (!last) return [{ at: open + 1, remove: 0, insert: raws }];
    return [{ at: last.end, remove: 0, insert: `, ${raws}` }];
  }
  const lineStart = text.lastIndexOf("\n", last.end - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, last.end))?.[0] ?? "    ";
  const hasComma = /^[ \t]*,/.test(text.slice(last.end, lastLineEnd));
  const lines = added.map((a) => `${indent}${a.raw},${a.comment ? `  ${a.comment}` : ""}`).join("\n");
  // The last item gets its comma when it had none (before its comment, if any).
  const comma: Splice[] = hasComma ? [] : [{ at: last.end, remove: 0, insert: "," }];
  // Applied from the end, so at the same offset the lines go in first and the comma lands in front of them.
  return [{ at: lastLineEnd, remove: 0, insert: `\n${lines}` }, ...comma];
}

/**
 * Moves the string items of the array at `from` to the end of the array at `into`, each with its same-line comment,
 * skipping those `into` already has, and deletes `from`. Both must be arrays written in the file.
 */
export function moveItems(text: string, from: KeyPath, into: KeyPath): string {
  const src = locate(text, from);
  const dst = locate(text, into);
  if (!src || !dst || text[src.valueStart] !== "[" || text[dst.valueStart] !== "[") {
    throw new Error(`${from.join(".")} 或 ${into.join(".")} 不是檔案裡寫出的陣列`);
  }
  const have = itemsOf(text, dst.valueStart, dst.valueEnd - 1).map((i) => JSON.stringify(i.value));
  const added: Item[] = [];
  for (const item of itemsOf(text, src.valueStart, src.valueEnd - 1)) {
    const id = JSON.stringify(item.value);
    if (have.includes(id)) continue;
    have.push(id);
    added.push(item);
  }
  const splices: Splice[] = [
    { at: src.lineStart, remove: Math.min(src.lineEnd + 1, text.length) - src.lineStart, insert: "" },
  ];
  if (added.length > 0) splices.push(...appendTo(text, dst, added));
  return splices
    .sort((a, b) => b.at - a.at)
    .reduce((t, s) => t.slice(0, s.at) + s.insert + t.slice(s.at + s.remove), text);
}
