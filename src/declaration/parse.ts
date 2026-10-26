import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import type { Finding } from "../report/finding.ts";
import type { Declaration, DeclaredComponent, RawOverride } from "./types.ts";

export interface ParseResult {
  declaration?: Declaration;
  findings: Finding[];
}

const TOP_LEVEL_KEYS = new Set(["standard", "components", "mirrors", "ignore"]);
const COMPONENT_KEYS = new Set(["path", "language", "overrides"]);

class Ctx {
  readonly findings: Finding[] = [];
  private readonly lines: LineCounter;
  readonly file: string;

  constructor(lines: LineCounter, file: string) {
    this.lines = lines;
    this.file = file;
  }

  lineOf(node: Node | Pair | null | undefined): number | undefined {
    const n = node && "range" in node ? node : (node as Pair | undefined)?.key;
    const offset = n && typeof n === "object" && "range" in n ? (n as Node).range?.[0] : undefined;
    return offset === undefined ? undefined : this.lines.linePos(offset).line;
  }

  error(rule: string, message: string, line?: number): void {
    this.findings.push({ level: "error", layer: "config", rule, message, file: this.file, line });
  }
}

function keyOf(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function readOverrides(ctx: Ctx, node: unknown, prefix: string): RawOverride[] {
  if (node === undefined || node === null) return [];
  if (!isMap(node)) {
    ctx.error("declaration/shape", `${prefix || "overrides"} 必須是 key: value 的對應表`, ctx.lineOf(node as Node));
    return [];
  }
  return node.items.map((pair) => ({
    key: prefix + keyOf(pair),
    raw: ((pair.value as Node | null)?.toJSON() as unknown) ?? null,
    line: ctx.lineOf(pair.key as Node),
  }));
}

function readString(ctx: Ctx, map: YAMLMap, key: string, where: string): string | undefined {
  const value = map.get(key, true);
  if (value === undefined) {
    ctx.error("declaration/shape", `${where}缺少 \`${key}\``, ctx.lineOf(map));
    return undefined;
  }
  if (!isScalar(value) || typeof value.value !== "string") {
    ctx.error("declaration/shape", `${where}的 \`${key}\` 必須是字串`, ctx.lineOf(value));
    return undefined;
  }
  return value.value;
}

function warnUnknownKeys(ctx: Ctx, map: YAMLMap, allowed: Set<string>, where: string): void {
  for (const pair of map.items) {
    const key = keyOf(pair);
    if (!allowed.has(key))
      ctx.error("declaration/shape", `${where}不認得的欄位 \`${key}\``, ctx.lineOf(pair.key as Node));
  }
}

function readComponent(ctx: Ctx, node: unknown, index: number): DeclaredComponent | undefined {
  const where = `components[${String(index)}] `;
  if (!isMap(node)) {
    ctx.error("declaration/shape", `${where}必須是包含 path 與 language 的對應表`, ctx.lineOf(node as Node));
    return undefined;
  }
  warnUnknownKeys(ctx, node, COMPONENT_KEYS, where);
  const path = readString(ctx, node, "path", where);
  const language = readString(ctx, node, "language", where);
  if (path === undefined || language === undefined) return undefined;
  return { path, language, overrides: readOverrides(ctx, node.get("overrides", true), ""), line: ctx.lineOf(node) };
}

function readComponents(ctx: Ctx, node: unknown): DeclaredComponent[] {
  if (node === undefined) {
    ctx.error("declaration/shape", "缺少 `components`");
    return [];
  }
  if (!isSeq(node)) {
    ctx.error("declaration/shape", "`components` 必須是清單", ctx.lineOf(node as Node));
    return [];
  }
  return node.items.flatMap((item, i) => readComponent(ctx, item, i) ?? []);
}

const isPathPattern = (item: unknown): boolean => isScalar(item) && typeof item.value === "string" && item.value !== "";

/** `ignore:`: a list of non-empty strings. Anything else is reported at the offending entry and ignores nothing. */
function readIgnore(ctx: Ctx, node: unknown): string[] {
  if (node === undefined || node === null) return [];
  const bad = isSeq(node) ? node.items.find((item) => !isPathPattern(item)) : node;
  if (bad !== undefined) {
    ctx.error("declaration/invalid", "`ignore` 必須是非空字串的清單（目錄、檔案路徑或 glob）", ctx.lineOf(bad as Node));
    return [];
  }
  return (node as { items: { value: string }[] }).items.map((item) => item.value);
}

/** Parses `.devguard.yaml`. Shape problems become findings; a declaration is returned whenever the root is readable. */
export function parseDeclaration(text: string, file: string): ParseResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const ctx = new Ctx(lines, file);
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      ctx.error("declaration/yaml-syntax", `YAML 語法錯誤：${e.message}`, lines.linePos(e.pos[0]).line);
    }
    return { findings: ctx.findings };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    ctx.error("declaration/shape", "宣告檔的最上層必須是對應表（standard、components）");
    return { findings: ctx.findings };
  }
  warnUnknownKeys(ctx, root, TOP_LEVEL_KEYS, "");
  const standard = readString(ctx, root, "standard", "") ?? "";
  const declaration: Declaration = {
    file,
    standard,
    standardLine: ctx.lineOf(root.get("standard", true)),
    components: readComponents(ctx, root.get("components", true)),
    globalOverrides: readOverrides(ctx, root.get("mirrors", true), "mirrors."),
    ignore: readIgnore(ctx, root.get("ignore", true)),
  };
  return { declaration, findings: ctx.findings };
}
