import { join } from "node:path";
import { dirName, upwards } from "../repo/paths.ts";
import { prettierOptions } from "../settings/typescript/prettier.ts";
import { readIfExists } from "../shared/fs.ts";
import { globSource, type GlobExtension } from "../shared/glob.ts";

/** One level of indentation of a new JSON file when the project says nothing: two spaces. */
const DEFAULT_WIDTH = 2;

/** `{lo..hi}` as an alternation of the numbers in it. */
function numberRange(a: string, b: string): string {
  const [lo, hi] = [Number(a), Number(b)].sort((x, y) => x - y) as [number, number];
  return `(?:${Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).join("|")})`;
}

const charClass = (token: string): string => `[${token.slice(1, -1).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;

/** What EditorConfig adds to the common globs: `[abc]`, `[!abc]`, `{a,b}` and `{1..3}`. */
function editorConfigSyntax(): GlobExtension {
  let depth = 0;
  return (glob, at) => {
    const rest = glob.slice(at);
    const range = /^\{(-?\d+)\.\.(-?\d+)\}/.exec(rest);
    if (range) return { source: numberRange(range[1] ?? "", range[2] ?? ""), length: range[0].length };
    const set = /^\[[^\]]*\]/.exec(rest);
    if (set) return { source: charClass(set[0]), length: set[0].length };
    if (/^\{[^{}]*,[^{}]*\}/.test(rest)) {
      depth++;
      return { source: "(?:", length: 1 };
    }
    if (depth > 0 && rest.startsWith("}")) {
      depth--;
      return { source: ")", length: 1 };
    }
    if (depth > 0 && rest.startsWith(",")) return { source: "|", length: 1 };
    return undefined;
  };
}

/** Translates an EditorConfig section glob into a regular expression over a `/`-separated path. */
function globToRegExp(glob: string): RegExp {
  const out = globSource(glob.replace(/^\//, ""), editorConfigSyntax());
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

/** The EditorConfig properties for `file` (repo-relative): `.editorconfig` files from its directory upward, nearer wins. */
async function editorConfig(cwd: string, file: string): Promise<Properties> {
  const layers: Properties[] = [];
  for (const dir of upwards(dirName(file))) {
    const text = await readIfExists(join(cwd, dir, ".editorconfig"));
    const { root, props } =
      text === undefined ? { root: false, props: {} } : sectionProperties(text, file.slice(dir.length));
    layers.unshift(props);
    if (root) break;
  }
  return Object.assign({}, ...layers) as Properties;
}

/** The value when it is a whole number above zero, else undefined: a width of 0 or 1.5 is no width. */
const positiveWidth = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * The indentation Prettier would give `file` if the project's setup decided it: the Prettier config's `useTabs` /
 * `tabWidth`, else `.editorconfig`'s `indent_style` / `indent_size` (Prettier merges the two the same way), else two
 * spaces (#211). `file` is repo-relative with forward slashes.
 */
export async function projectIndent(cwd: string, file: string): Promise<string> {
  const subDir = dirName(file);
  const prettier = (await prettierOptions(join(cwd, subDir), subDir)) ?? {};
  const ec = await editorConfig(cwd, file);
  const useTabs = typeof prettier.useTabs === "boolean" ? prettier.useTabs : ec.indent_style === "tab";
  if (useTabs) return "\t";
  const size = Number(ec.indent_size === "tab" ? ec.tab_width : ec.indent_size);
  return " ".repeat(positiveWidth(prettier.tabWidth) ?? positiveWidth(size) ?? DEFAULT_WIDTH);
}
