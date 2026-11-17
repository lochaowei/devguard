import { join } from "node:path";
import { prettierOptions } from "../settings/typescript/prettier.ts";
import { readIfExists } from "../shared/fs.ts";

/** One level of indentation of a new JSON file when the project says nothing: two spaces. */
const DEFAULT_WIDTH = 2;

const GLOB_TOKEN = /\*\*|\*|\?|\[[^\]]*\]|\{(-?\d+)\.\.(-?\d+)\}|(\{)(?=[^{}]*,[^{}]*\})|[{},]|[.+^$()|\\]/g;
const FIXED: Record<string, string> = { "**": ".*", "*": "[^/]*", "?": "[^/]" };

/** `{lo..hi}` as an alternation of the numbers in it. */
function numberRange(a: string, b: string): string {
  const [lo, hi] = [Number(a), Number(b)].sort((x, y) => x - y) as [number, number];
  return `(?:${Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).join("|")})`;
}

const charClass = (token: string): string => `[${token.slice(1, -1).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;

/** Translates an EditorConfig section glob into a regular expression over a `/`-separated path. */
function globToRegExp(glob: string): RegExp {
  let depth = 0;
  const brace = (token: string, opens: boolean): string => {
    if (opens) depth++;
    else if (token === "}" && depth > 0) depth--;
    else return depth > 0 && token === "," ? "|" : `\\${token}`;
    return opens ? "(?:" : ")";
  };
  const out = glob.replace(/^\//, "").replace(GLOB_TOKEN, (token: string, lo?: string, hi?: string, open?: string) => {
    if (lo !== undefined && hi !== undefined) return numberRange(lo, hi);
    if (token.startsWith("[")) return charClass(token);
    return FIXED[token] ?? brace(token, open !== undefined);
  });
  return new RegExp(glob.includes("/") ? `^${out}$` : `^(?:.*/)?${out}$`);
}

type Properties = Record<string, string>;
interface Parsed {
  root: boolean;
  props: Properties;
}

/** Reads one `key = value` line into `root` (before the first section) or into `props` (inside a matching one). */
function readPair(line: string, parsed: Parsed, where: "preamble" | "match" | "other"): void {
  const pair = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
  if (!pair || where === "other") return;
  const key = (pair[1] ?? "").toLowerCase();
  const value = (pair[2] ?? "").trim().toLowerCase();
  if (where === "match") parsed.props[key] = value;
  else if (key === "root" && value === "true") parsed.root = true;
}

/** The properties an `.editorconfig` assigns to `relPath` (relative to its directory); later sections win. */
function sectionProperties(text: string, relPath: string): Parsed {
  const parsed: Parsed = { root: false, props: {} };
  let where: "preamble" | "match" | "other" = "preamble";
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || /^[#;]/.test(line)) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) where = globToRegExp(section[1] ?? "").test(relPath) ? "match" : "other";
    else readPair(line, parsed, where);
  }
  return parsed;
}

const upFrom = (dir: string): string => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");

/** The EditorConfig properties for `file` (repo-relative): `.editorconfig` files from its directory upward, nearer wins. */
async function editorConfig(cwd: string, file: string): Promise<Properties> {
  const layers: Properties[] = [];
  let dir = upFrom(file);
  for (;;) {
    const text = await readIfExists(join(cwd, dir, ".editorconfig"));
    const { root, props } =
      text === undefined
        ? { root: false, props: {} }
        : sectionProperties(text, dir === "" ? file : file.slice(dir.length + 1));
    layers.unshift(props);
    if (root || dir === "") break;
    dir = upFrom(dir);
  }
  return Object.assign({}, ...layers) as Properties;
}

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * The indentation Prettier would give `file` if the project's setup decided it: the Prettier config's `useTabs` /
 * `tabWidth`, else `.editorconfig`'s `indent_style` / `indent_size` (Prettier merges the two the same way), else two
 * spaces (#211). `file` is repo-relative with forward slashes.
 */
export async function projectIndent(cwd: string, file: string): Promise<string> {
  const subDir = upFrom(file);
  const prettier = (await prettierOptions(join(cwd, subDir), subDir)) ?? {};
  const ec = await editorConfig(cwd, file);
  const useTabs = typeof prettier.useTabs === "boolean" ? prettier.useTabs : ec.indent_style === "tab";
  if (useTabs) return "\t";
  const size = Number(ec.indent_size === "tab" ? ec.tab_width : ec.indent_size);
  return " ".repeat(positive(prettier.tabWidth) ?? positive(size) ?? DEFAULT_WIDTH);
}
