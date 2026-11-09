import { parse as parseToml, patch as patchToml, stringify as stringifyToml } from "@decimalturn/toml-patch";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse as parseJsoncTree,
  parseTree,
  type Edit,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { isScalar, isSeq, parse as parseYaml, parseDocument, type Document, type YAMLSeq } from "yaml";
import { baseName } from "../repo/paths.ts";
import type { KeyEdit, KeyPath } from "./repair.ts";
import { moveItems, renameKey } from "./toml-text.ts";
import { renderKeepingLayout } from "./yaml-text.ts";

/** How a structured shared file is read and written. */
export type EditFormat = "toml" | "jsonc" | "yaml" | "lines";

const LINE_FILES = new Set([".gitattributes", ".gitignore", "lombok.config"]);

/** The format of a file whose managed keys the CLI may edit; undefined when it is not a structured file it can edit. */
export function editFormat(file: string, text = ""): EditFormat | undefined {
  const name = baseName(file);
  if (LINE_FILES.has(name)) return "lines";
  if (name === ".prettierrc") return text.trim() === "" || text.trimStart().startsWith("{") ? "jsonc" : "yaml";
  if (/\.toml$/.test(name)) return "toml";
  if (/\.(json|jsonc|json5)$/.test(name)) return "jsonc";
  if (/\.ya?ml$/.test(name)) return "yaml";
  return undefined;
}

type Obj = Record<string | number, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type PathEdit = Exclude<KeyEdit, { op: "line" | "rename" | "move" }>;

const pathEdits = (edits: readonly KeyEdit[]): PathEdit[] =>
  edits.filter((e): e is PathEdit => e.op !== "line" && e.op !== "rename" && e.op !== "move");

/** Renames and moves are TOML text edits (src/fix/toml-text.ts), applied before the value edits. */
function textEdits(text: string, edits: readonly KeyEdit[]): string {
  let out = text;
  for (const e of edits) {
    if (e.op === "rename") out = renameKey(out, e.path, e.to);
    if (e.op === "move") out = moveItems(out, e.path, e.into);
  }
  return out;
}

/** The array an add/remove produces from the current value. */
function listAfter(edit: PathEdit & { op: "add" | "remove" }, current: unknown): unknown[] {
  const list: unknown[] = Array.isArray(current) ? current : [];
  if (edit.op === "remove") return list.filter((v) => !same(v, edit.value));
  return list.some((v) => same(v, edit.value)) ? list : [...list, edit.value];
}

function getIn(root: unknown, path: KeyPath): unknown {
  let cur = root;
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

/** Sets (or, with `undefined`, deletes) a value in a plain object tree, creating tables along the way. */
function setIn(root: Obj, path: KeyPath, value: unknown): void {
  let cur = root;
  for (const k of path.slice(0, -1)) {
    const next = cur[k];
    if (!isObj(next)) cur[k] = {};
    cur = cur[k] as Obj;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  if (value === undefined) Reflect.deleteProperty(cur, last);
  else cur[last] = value;
}

function valueAfter(edit: PathEdit, current: unknown): unknown {
  if (edit.op === "set") return edit.value;
  if (edit.op === "delete") return undefined;
  return listAfter(edit, current);
}

const bareKey = (k: string | number): string => (/^[A-Za-z0-9_-]+$/.test(String(k)) ? String(k) : JSON.stringify(k));

const TOML_FORMAT = { inlineTableStart: 99 };

/** Blank line before an appended section. */
function separator(out: string): string {
  if (out === "" || out.endsWith("\n\n")) return "";
  return out.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * Whether the file already defines the table, by `[header]`, dotted keys (`lint.select` under `[tool.ruff]`) or an
 * inline table, so its keys are edited in place. A table that exists only because a sub-table's header names it
 * (`[tool.ruff]` when only `[tool.ruff.lint]` is written) may still be declared, and gets its own `[section]` block.
 * Declaring is allowed exactly when appending the header still parses.
 */
function hasTomlTable(text: string, doc: Obj, table: KeyPath, name: string): boolean {
  if (text.trim() === "") return false;
  if (table.length === 0) return true;
  if (!isObj(getIn(doc, table))) return false;
  if (table.some((k) => typeof k === "number")) return true;
  try {
    parseToml(`${text}\n[${name}]\n`);
    return false;
  } catch {
    // `text` already parsed (doc came from it), so the only way the append fails is redeclaring the table. A library
    // bug landing here instead just means an in-place edit, and planChanges refuses any TOML result that won't parse.
    return true;
  }
}

/**
 * Tables added to arrays that do not exist yet ([[tool.uv.index]]), by array name: appended as `[[...]]` blocks,
 * since toml-patch would write them inline.
 */
function newArrayTables(adds: readonly PathEdit[]): Map<string, Obj[]> {
  const arrays = new Map<string, Obj[]>();
  for (const e of adds) {
    if (e.op !== "add" || !isObj(e.value)) continue;
    const name = e.path.map(bareKey).join(".");
    const items = arrays.get(name) ?? [];
    if (!items.some((v) => same(v, e.value))) arrays.set(name, [...items, e.value]);
  }
  return arrays;
}

/**
 * toml-patch writes a key of a table that does not exist yet as a dotted key at the top of the file
 * (`tool.mypy = {strict = true}`), so keys of new tables are collected and appended as `[section]` blocks instead.
 */
function editToml(original: string, edits: readonly KeyEdit[]): string {
  const text = textEdits(original, edits);
  const empty = text.trim() === "";
  const doc = (empty ? {} : parseToml(text)) as Obj;
  const newArray = (e: PathEdit) => e.op === "add" && isObj(e.value) && getIn(doc, e.path) === undefined;
  const arrayTables = newArrayTables(pathEdits(edits).filter(newArray));
  const sections = new Map<string, Obj>();
  for (const e of pathEdits(edits).filter((x) => !newArray(x))) {
    const table = e.path.slice(0, -1);
    const key = String(e.path[e.path.length - 1]);
    const name = table.map(bareKey).join(".");
    const section = sections.get(name);
    const value = valueAfter(e, getIn(doc, e.path) ?? section?.[key]);
    if (value !== undefined && !hasTomlTable(text, doc, table, name)) sections.set(name, { ...section, [key]: value });
    else setIn(doc, e.path, value);
  }
  const blocks = [
    // Top-level keys of an empty file (a new ruff.toml) have no section header.
    ...[...sections].map(([name, values]) => ({ head: name ? `[${name}]\n` : "", name, values })),
    ...[...arrayTables].flatMap(([name, items]) => items.map((values) => ({ head: `[[${name}]]\n`, name, values }))),
  ];
  let out = empty ? "" : patchToml(text, doc, TOML_FORMAT);
  for (const { head, name, values } of blocks) {
    out += `${separator(out)}${head}${underTable(stringifyToml(values, TOML_FORMAT), name).trimEnd()}\n`;
  }
  return out;
}

/** One TOML key segment: bare, "basic" (with escapes) or 'literal'. */
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
/** A whole `[table]` or `[[array]]` header line, whose key may hold quoted segments with brackets in them. */
const TABLE_HEADER = new RegExp(
  String.raw`^(\[\[?)[ \t]*(${KEY_SEGMENT}(?:[ \t]*\.[ \t]*${KEY_SEGMENT})*)[ \t]*(\]\]?)[ \t]*$`,
);

/** Whether a line opens or closes a multi-line string: an odd number of `"""` or `'''` delimiters on it. */
const togglesMultiline = (line: string): boolean => ((line.match(/"""|'''/g) ?? []).length & 1) === 1;

/**
 * stringify writes the sub-tables of a section's values (`rules.main` under `[linters.settings.depguard]`) with
 * headers relative to the root, so they get the section's name in front. Only real header lines are renamed: a line
 * inside a multi-line string that merely looks like `[x]` is left alone.
 */
function underTable(toml: string, name: string): string {
  if (name === "") return toml;
  let inString = false;
  return toml
    .split("\n")
    .map((line) => {
      const header = inString ? null : TABLE_HEADER.exec(line);
      if (togglesMultiline(line)) inString = !inString;
      if (!header) return line;
      const [, open = "", key = "", close = ""] = header;
      return `${open}${name}.${key}${close}`;
    })
    .join("\n");
}

function jsonFormatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return { insertSpaces: !indent.startsWith("\t"), tabSize: indent.startsWith("\t") ? 1 : indent.length, eol: "\n" };
}

/** Prettier's default print width: a written array of plain values that fits stays on one line. */
const DEFAULT_WIDTH = 80;
const PLAIN_ARRAY = /\[\n(?:[ \t]*(?:"(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*|true|false|null),?\n)+[ \t]*\]/g;

/**
 * jsonc-parser writes every array one value per line; Prettier puts an array of plain values on one line when it fits.
 * Only the text an edit writes is changed, so arrays already in the file keep their layout.
 */
function inlineShortArrays(content: string, column: number, width: number): string {
  return content.replace(PLAIN_ARRAY, (array: string, at: number) => {
    const lineStart = content.lastIndexOf("\n", at) + 1;
    const lead = (lineStart === 0 ? column : 0) + at - lineStart;
    const values = array
      .slice(1, -1)
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l !== "");
    const inline = `[${values.join(", ")}]`;
    const tail = /^,?/.exec(content.slice(at + array.length))?.[0] ?? "";
    return lead + inline.length + tail.length <= width ? inline : array;
  });
}

/** The rest of a line after a value: an optional comma, then only comments (`/* … *\/`, `// …`). */
const TRAILING_COMMENT = /^[ \t]*(?<comma>,?)(?<comment>[ \t]*(?:\/\*.*?\*\/[ \t]*)*(?:\/\/.*)?)$/;

/** Where the line of a value ending at `valueEnd` ends, when the rest of it is a comment; undefined otherwise. */
function trailingComment(text: string, valueEnd: number): { lineEnd: number; comma: boolean } | undefined {
  const newline = text.indexOf("\n", valueEnd);
  const lineEnd = newline < 0 ? text.length : newline;
  const groups = TRAILING_COMMENT.exec(text.slice(valueEnd, lineEnd))?.groups;
  if (!groups || (groups.comment ?? "").trim() === "") return undefined;
  return { lineEnd, comma: groups.comma === "," };
}

/** The last property of the object a new key would be appended to; undefined when the key exists or there is none. */
function lastPropertyOf(text: string, path: KeyPath): JsonNode | undefined {
  const key = path[path.length - 1];
  const root = parseTree(text);
  const parent = root && findNodeAtLocation(root, path.slice(0, -1));
  if (key === undefined || parent?.type !== "object" || findNodeAtLocation(parent, [key])) return undefined;
  return parent.children?.at(-1);
}

/**
 * jsonc-parser appends a property right after the previous property's value, so a comment at the end of that line
 * would end up after the new property, describing it (#121). When the rest of that line is a comment, the new property
 * goes on the next line with the same indent instead, and the line stays as it was apart from a missing comma, which
 * goes before the comment. Undefined when the edit is not such an append.
 */
function appendBelowTrailingComment(
  text: string,
  path: KeyPath,
  value: unknown,
  options: { formattingOptions: FormattingOptions; width: number },
): Edit[] | undefined {
  const last = value === undefined ? undefined : lastPropertyOf(text, path);
  if (!last) return undefined;
  const valueEnd = last.offset + last.length;
  const indent = text.slice(text.lastIndexOf("\n", last.offset - 1) + 1, last.offset);
  const rest = trailingComment(text, valueEnd);
  if (!rest || !/^[ \t]*$/.test(indent)) return undefined;
  const { lineEnd } = rest;
  const name = `${JSON.stringify(String(path[path.length - 1]))}: `;
  const written = applyEdits("", modify("", [], value, { formattingOptions: options.formattingOptions }));
  const property = `${name}${inlineShortArrays(written, indent.length + name.length, options.width)}`;
  const content = `\n${indent}${property.replace(/\n/g, `\n${indent}`)}`;
  if (rest.comma) return [{ offset: lineEnd, length: 0, content: `${content},` }];
  return [
    { offset: valueEnd, length: 0, content: "," },
    { offset: lineEnd, length: 0, content },
  ];
}

function editJsonc(text: string, edits: readonly KeyEdit[]): string {
  let out = text.trim() === "" ? "{}\n" : text;
  const formattingOptions = jsonFormatting(out);
  for (const e of pathEdits(edits)) {
    const value = valueAfter(e, getIn(parseJsoncTree(out), e.path));
    const width = ("layout" in e ? e.layout?.printWidth : undefined) ?? DEFAULT_WIDTH;
    const changes =
      appendBelowTrailingComment(out, e.path, value, { formattingOptions, width }) ??
      modify(out, [...e.path], value, { formattingOptions }).map((c) => ({
        ...c,
        content: inlineShortArrays(c.content, c.offset - out.lastIndexOf("\n", c.offset - 1) - 1, width),
      }));
    out = applyEdits(out, changes);
  }
  return out;
}

/** Adds to or removes from an existing YAML sequence in place, so its style and comments stay. */
function editSeq(doc: Document, seq: YAMLSeq, e: PathEdit & { op: "add" | "remove" }): void {
  const items: unknown = seq.toJSON();
  const at = Array.isArray(items) ? items.findIndex((v) => same(v, e.value)) : -1;
  if (e.op === "add" && at < 0) seq.add(doc.createNode(e.value));
  if (e.op === "remove" && at >= 0) seq.delete(at);
}

function editYaml(text: string, edits: readonly KeyEdit[]): string {
  const doc = parseDocument(text);
  for (const e of pathEdits(edits)) {
    const node: unknown = doc.getIn(e.path, true);
    if (e.op === "delete") doc.deleteIn(e.path);
    else if (e.op === "set" && isScalar(node) && !isObj(e.value)) node.value = e.value;
    else if (e.op === "set") doc.setIn(e.path, doc.createNode(e.value));
    else if (isSeq(node)) editSeq(doc, node, e);
    else doc.setIn(e.path, doc.createNode(listAfter(e, undefined)));
  }
  return renderKeepingLayout(doc, text);
}

function editLines(text: string, edits: readonly KeyEdit[]): string {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const e of edits) if (e.op === "line" && !lines.some((l) => l.trim() === e.value)) lines.push(e.value);
  return lines.join("\n") + "\n";
}

const EDITORS: Record<EditFormat, (text: string, edits: readonly KeyEdit[]) => string> = {
  toml: editToml,
  jsonc: editJsonc,
  yaml: editYaml,
  lines: editLines,
};

/** Whether a file's line breaks are mostly CRLF (a file committed with CRLF, or checked out with it). */
export function usesCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

/**
 * Applies edits to the CLI-managed keys of a structured shared file and leaves everything else (comments, blank
 * lines, key order, CRLF line endings) as it was (SPEC §9.2, #84). `text` is "" for a file that does not exist yet,
 * which gets LF.
 */
export function editConfigText(file: string, text: string, edits: readonly KeyEdit[]): string {
  const format = editFormat(file, text);
  if (!format) throw new Error(`${file} 不是 CLI 能修改的結構化設定檔`);
  const out = EDITORS[format](text.replace(/\r\n/g, "\n"), edits);
  return usesCrlf(text) ? out.replace(/\n/g, "\r\n") : out;
}

/**
 * A structured config file's content as plain data, with the same libraries that edit it (TOML, JSONC, YAML);
 * undefined when it is not one of those or does not parse. "" parses to an empty object.
 */
export function parseConfigText(file: string, text: string): unknown {
  if (text.trim() === "") return {};
  try {
    switch (editFormat(file, text)) {
      case "toml":
        return parseToml(text) as unknown;
      case "jsonc": {
        const errors: ParseError[] = [];
        const value = parseJsoncTree(text, errors, { allowTrailingComma: true }) as unknown;
        return errors.length === 0 ? value : undefined;
      }
      case "yaml":
        return parseYaml(text) as unknown;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
