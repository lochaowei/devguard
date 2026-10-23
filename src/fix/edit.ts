import { parse as parseToml, patch as patchToml, stringify as stringifyToml } from "@decimalturn/toml-patch";
import { applyEdits, modify, parse as parseJsoncTree, type FormattingOptions } from "jsonc-parser";
import { isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import type { KeyEdit, KeyPath } from "./repair.ts";

/** How a structured shared file is read and written. */
export type EditFormat = "toml" | "jsonc" | "yaml" | "lines" | "ini";

const LINE_FILES = new Set([".gitattributes", ".gitignore"]);

const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/** The format of a file whose managed keys the CLI may edit; undefined when it is not a structured file it can edit. */
export function editFormat(file: string, text = ""): EditFormat | undefined {
  const name = baseName(file);
  if (LINE_FILES.has(name)) return "lines";
  if (name === ".npmrc") return "ini";
  if (name === ".prettierrc") return text.trim() === "" || text.trimStart().startsWith("{") ? "jsonc" : "yaml";
  if (/\.toml$/.test(name)) return "toml";
  if (/\.(json|jsonc|json5)$/.test(name)) return "jsonc";
  if (/\.ya?ml$/.test(name)) return "yaml";
  return undefined;
}

type Obj = Record<string | number, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type PathEdit = Exclude<KeyEdit, { op: "line" }>;

const pathEdits = (edits: readonly KeyEdit[]): PathEdit[] => edits.filter((e): e is PathEdit => e.op !== "line");

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
function editToml(text: string, edits: readonly KeyEdit[]): string {
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
    if (value !== undefined && !isObj(getIn(doc, table))) sections.set(name, { ...section, [key]: value });
    else setIn(doc, e.path, value);
  }
  const blocks = [
    ...[...sections].map(([name, values]) => ({ head: `[${name}]`, values })),
    ...[...arrayTables].flatMap(([name, items]) => items.map((values) => ({ head: `[[${name}]]`, values }))),
  ];
  let out = empty ? "" : patchToml(text, doc, TOML_FORMAT);
  for (const { head, values } of blocks) {
    out += `${separator(out)}${head}\n${stringifyToml(values, TOML_FORMAT).trimEnd()}\n`;
  }
  return out;
}

function jsonFormatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return { insertSpaces: !indent.startsWith("\t"), tabSize: indent.startsWith("\t") ? 1 : indent.length, eol: "\n" };
}

function editJsonc(text: string, edits: readonly KeyEdit[]): string {
  let out = text.trim() === "" ? "{}\n" : text;
  const formattingOptions = jsonFormatting(out);
  for (const e of pathEdits(edits)) {
    const value = valueAfter(e, getIn(parseJsoncTree(out), e.path));
    out = applyEdits(out, modify(out, [...e.path], value, { formattingOptions }));
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
  return doc.toString();
}

function editLines(text: string, edits: readonly KeyEdit[]): string {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const e of edits) if (e.op === "line" && !lines.some((l) => l.trim() === e.value)) lines.push(e.value);
  return lines.join("\n") + "\n";
}

function iniKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) return undefined;
  const at = trimmed.indexOf("=");
  return at < 0 ? undefined : trimmed.slice(0, at).trim();
}

/** `key=value` files (.npmrc): `set` replaces the key's line or appends one, `delete` drops it; the rest stays. */
function editIni(text: string, edits: readonly KeyEdit[]): string {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const e of pathEdits(edits)) {
    const key = String(e.path[0]);
    const at = lines.findIndex((l) => iniKey(l) === key);
    if (e.op === "delete" && at >= 0) lines.splice(at, 1);
    if (e.op !== "set") continue;
    const line = `${key}=${String(e.value)}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return lines.join("\n") + "\n";
}

const EDITORS: Record<EditFormat, (text: string, edits: readonly KeyEdit[]) => string> = {
  toml: editToml,
  jsonc: editJsonc,
  yaml: editYaml,
  lines: editLines,
  ini: editIni,
};

/**
 * Applies edits to the CLI-managed keys of a structured shared file and leaves everything else (comments, blank
 * lines, key order) as it was (SPEC §9.2). `text` is "" for a file that does not exist yet.
 */
export function editConfigText(file: string, text: string, edits: readonly KeyEdit[]): string {
  const format = editFormat(file, text);
  if (!format) throw new Error(`${file} 不是 CLI 能修改的結構化設定檔`);
  return EDITORS[format](text, edits);
}
