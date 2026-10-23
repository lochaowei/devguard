import type { ResolvedComponent } from "../../declaration/resolve.ts";
import type { Finding, Level } from "../../report/finding.ts";
import type { ItemDef } from "../../standard/types.ts";
import { parseXmlText, type XmlEl } from "../../xml/parse.ts";
import { judgeConfigValue } from "../judge.ts";
import { regenerate } from "./generate.ts";

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
  where: { file: string; line: number; setting: string },
): Finding[] {
  const item = t.defs[key];
  if (!item) return [];
  if (!/^\d+$/.test(raw.trim())) {
    return [
      finding(
        t,
        "hint",
        "java/config-value-unreadable",
        `${where.file}：無法判讀 ${where.setting} 的值「${raw}」，請確認不比宣告的 ${item.label} 寬鬆`,
        { file: where.file, line: where.line },
      ),
    ];
  }
  const site = { component: t.component.name, file: where.file, line: where.line };
  const repair = () => regenerate(t, where.file);
  const judged = judgeConfigValue(key, item, t.component.effective[key], Number(raw), site, undefined, repair);
  return judged ? [judged] : [];
}

export const FIX_GENERATE = "devguard fix（由 CLI 重新產生）";

/** What a finding that `fix` resolves by regenerating the CLI-owned `file` carries. */
export function generated(t: JavaTarget, file: string): Partial<Finding> {
  return { fix: FIX_GENERATE, repairs: regenerate(t, file) };
}

/** Reads and parses a CLI-generated XML config; malformed XML is an error that `fix` resolves by regenerating. */
export async function readXmlConfig(t: JavaTarget, file: string): Promise<XmlEl | Finding> {
  const parsed = parseXmlText(await t.read(file));
  if (parsed.ok) return parsed.root;
  return finding(t, "error", "java/config-unparseable", `${file}：XML 格式錯誤：${parsed.message}`, {
    file,
    line: parsed.line,
    ...generated(t, file),
  });
}

export const isFinding = (x: XmlEl | Finding): x is Finding => "rule" in x;
