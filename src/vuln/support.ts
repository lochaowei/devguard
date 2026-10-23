import type { Finding, Level } from "../report/finding.ts";
import type { ToolResult } from "../tools/runner.ts";
import type { VulnTarget } from "./types.ts";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Splits a stream of concatenated JSON values (govulncheck -json prints pretty-printed objects one after another).
 * Returns undefined when the text is not such a stream.
 */
export function parseJsonStream(text: string): unknown[] | undefined {
  const chunks: string[] = [];
  let depth = 0;
  let start = 0;
  // Strings are matched whole, so brackets inside them are not counted.
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
    const token = m[0];
    if (token.startsWith('"')) continue;
    if (token === "{" || token === "[") {
      if (depth === 0) start = m.index;
      depth++;
    } else if (--depth === 0) chunks.push(text.slice(start, m.index + 1));
  }
  return depth === 0 ? parseChunks(text, chunks) : undefined;
}

/** Each chunk parsed, when every one is JSON and nothing else is in the text. */
function parseChunks(text: string, chunks: readonly string[]): unknown[] | undefined {
  const values = chunks.map(parseJson);
  const outside = chunks.reduce((rest, chunk) => rest.replace(chunk, ""), text).trim();
  return values.length > 0 && outside === "" && !values.includes(undefined) ? values : undefined;
}

/** The strings in a JSON array; anything else is ignored. */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

const where = (target: VulnTarget) => (target.dir === "" ? "repo 根目錄" : target.dir);

/** A finding about the scan of a component (layer "code", like test and coverage results). */
export function scanFinding(target: VulnTarget, level: Level, rule: string, message: string, fix: string): Finding {
  return { level, layer: "code", rule, message, component: target.component, fix };
}

/** The scanner did not produce a usable result. */
export function scanFailed(target: VulnTarget, tool: string, result: ToolResult): Finding {
  const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-5).join("\n");
  return scanFinding(
    target,
    "error",
    "vuln/tool-failed",
    `弱點掃描 ${tool} 執行失敗（exit ${String(result.code)}）${output === "" ? "" : `：${output}`}`,
    `在 ${where(target)} 直接執行 ${tool} 查看完整訊息`,
  );
}

/** The internal data source a scanner needs is not configured. */
export function noMirror(target: VulnTarget, key: string, tool: string): Finding {
  return scanFinding(
    target,
    "error",
    "vuln/no-mirror",
    `弱點掃描需要內部資料來源 ${key}，目前沒有設定，無法執行 ${tool}`,
    `在 .devguard.yaml 的 mirrors 設定 ${key.replace(/^mirrors\./, "")}`,
  );
}

/** The configured mirror value, or undefined when it is missing or blank. */
export function mirrorOf(target: VulnTarget, key: string): string | undefined {
  const value = target.effective[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
