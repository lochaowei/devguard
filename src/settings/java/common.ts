import type { ResolvedComponent } from "../../declaration/resolve.ts";
import type { Finding, Level } from "../../report/finding.ts";
import type { ItemDef } from "../../standard/types.ts";
import { parseXmlText, type XmlEl } from "../../xml/parse.ts";
import { judgeConfigValue } from "../judge.ts";
import type { Repair } from "../../fix/repair.ts";
import { isForeign } from "../../fix/plan.ts";
import { fixText } from "../../fix/category.ts";
import { generatedContent, regenerate } from "./generate.ts";

/** One Java component under check, with what the checks need to read and judge its config files. */
export interface JavaTarget {
  component: ResolvedComponent;
  /** The Java items of the standard the component inherits. */
  defs: Readonly<Record<string, ItemDef>>;
  /** Repo-relative paths of the repo's files. */
  files: ReadonlySet<string>;
  read(path: string): Promise<string>;
}

export function finding(
  t: JavaTarget,
  level: Level,
  rule: string,
  message: string,
  extra: Partial<Finding> = {},
): Finding {
  return { level, layer: "config", rule, message, component: t.component.name, ...extra };
}

/** The first of `candidates` (relative to the component directory) that is in the repo. */
export function findConfig(t: JavaTarget, candidates: readonly string[]): string | undefined {
  return candidates.map((c) => t.component.dir + c).find((p) => t.files.has(p));
}

/** Declared integer setting (e.g. a complexity limit) vs. the one in a config file; unreadable values become a hint. */
export function judgeNumber(
  t: JavaTarget,
  key: string,
  raw: string,
  where: { file: string; line: number; setting: string; own: OwnConfig },
): Finding[] {
  const item = t.defs[key];
  if (!item) return [];
  if (!/^\d+$/.test(raw.trim())) {
    return [
      finding(
        t,
        "hint",
        "settings/config-value-unreadable",
        `${where.file}：無法判讀 ${where.setting} 的值「${raw}」，請確認不比宣告的 ${item.label} 寬鬆`,
        { file: where.file, line: where.line },
      ),
    ];
  }
  const site = { component: t.component.name, file: where.file, line: where.line };
  const repair = () => repairsFor(t, where.file, where.own);
  const declared = t.component.effective[key];
  const judged = judgeConfigValue({ key, item, declared, actual: Number(raw), site, repair });
  return judged ? [judged] : [];
}

export const FIX_GENERATE = "devguard fix（由 CLI 重新產生）";

/**
 * An existing CLI-owned config file as a finding about it sees it: its text, and what to add to it by hand (a snippet
 * of the generated content) should it turn out not to be devguard's.
 */
export interface OwnConfig {
  text: string;
  /** What to add by hand; the whole generated content when absent. */
  missing?: string;
}

/** Regenerate the file, or, for a file devguard did not generate, print the part to add (#100). */
function repairsFor(t: JavaTarget, file: string, own: OwnConfig | undefined): Repair[] {
  if (!own || !isForeign(own.text)) return regenerate(t, file);
  return [{ op: "snippet", file, text: own.missing ?? generatedContent(t, file) }];
}

/**
 * What a finding about the CLI-owned `file` carries: `fix` regenerates it, or, when the existing file is not
 * devguard's (`own`), only prints what to add (#100).
 */
export function generated(t: JavaTarget, file: string, own?: OwnConfig): Partial<Finding> {
  const repairs = repairsFor(t, file, own);
  if (repairs.every((r) => r.op === "generate")) return { fix: FIX_GENERATE, repairs };
  return { fix: fixText(`${file} 不是 devguard 產生的，不會覆寫；請自行加入缺少的設定`, repairs), repairs };
}

/** The `missing` of a snippet: where it goes, then the elements, each line on its own. */
export const snippet = (where: string, lines: readonly string[]): string => [where, ...lines].join("\n");

/** A parsed CLI-owned XML config and its text. */
export interface XmlConfig {
  root: XmlEl;
  text: string;
}

/** Reads and parses a CLI-generated XML config; malformed XML is an error that `fix` resolves by regenerating. */
export async function readXmlConfig(t: JavaTarget, file: string): Promise<XmlConfig | Finding> {
  const text = await t.read(file);
  const parsed = parseXmlText(text);
  if (parsed.ok) return { root: parsed.root, text };
  return finding(t, "error", "settings/config-unparseable", `${file}：XML 格式錯誤：${parsed.message}`, {
    file,
    line: parsed.line,
    ...generated(t, file, { text }),
  });
}

export const isFinding = (x: XmlConfig | Finding): x is Finding => "rule" in x;
