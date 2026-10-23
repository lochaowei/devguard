import { join } from "node:path";
import { parse as parseJsoncTree, type ParseError } from "jsonc-parser";
import { readIfExists } from "../shared/fs.ts";
import { isRecord } from "../shared/guards.ts";

export interface FoundFile {
  name: string;
  text: string;
}

/** The first of `names` that exists in `dir`, in order. */
export async function findFirst(dir: string, names: readonly string[]): Promise<FoundFile | undefined> {
  for (const name of names) {
    const text = await readIfExists(join(dir, name));
    if (text !== undefined) return { name, text };
  }
  return undefined;
}

/** Parses JSON with comments and trailing commas; undefined when it is not valid. */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsoncTree(text, errors, { allowTrailingComma: true }) as unknown;
  return errors.length === 0 ? value : undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Where a property `name: <value>` (or `name = <value>` with `assign: "="`) starts its value in config source text. */
export function propertyValueIndex(text: string, name: string, assign = ":"): number | undefined {
  const re = new RegExp(`(?:^|[\\s{,(])(["']?)${escapeRegExp(name)}\\1\\s*${assign}\\s*`, "m");
  const m = re.exec(text);
  return m ? m.index + m[0].length : undefined;
}

/**
 * Reads a literal value (number, string, boolean) of a property from config source text that cannot be evaluated,
 * such as `prettier.config.js`. Undefined when the property is absent or not a literal.
 */
export function literalProperty(text: string, name: string, assign = ":"): string | number | boolean | undefined {
  const start = propertyValueIndex(text, name, assign);
  if (start === undefined) return undefined;
  const m = /^(?:(-?\d+(?:\.\d+)?)\b|"([^"]*)"|'([^']*)'|(true|false)\b)/.exec(text.slice(start));
  if (!m) return undefined;
  if (m[1] !== undefined) return Number(m[1]);
  if (m[4] !== undefined) return m[4] === "true";
  return m[2] ?? m[3];
}

/** The `{ ... }` source text of an object-literal property, braces included; undefined when absent or not a literal. */
export function objectProperty(text: string, name: string): string | undefined {
  const start = propertyValueIndex(text, name);
  if (start === undefined || text.charAt(start) !== "{") return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Signs that a code-form config pulls settings from somewhere this file does not show. */
export const pullsFromElsewhere = (text: string): boolean => /\bmergeConfig\b|\.\.\.|\bpreset\b|\bextends\b/.test(text);

/** Follows a dotted path through nested objects. */
export function at(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}
