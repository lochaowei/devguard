import { DECLARATION_FILE } from "../declaration/types.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles } from "../repo/files.ts";
import { LANGUAGE_LABEL, type Language } from "../standard/types.ts";
import { scopedFiles, type CheckLayer } from "./types.ts";

/** Program files no component covers get the default standard, with a hint to declare a component (SPEC §4.1). */
export const uncoveredFilesLayer: CheckLayer = {
  id: "uncovered-files",
  async run(ctx) {
    if (!ctx.resolution?.standard) return { findings: [] };
    const byLanguage = new Map<Language, string[]>();
    for (const { file, owner } of assignFiles(ctx.resolution.components, await scopedFiles(ctx))) {
      if (owner.kind !== "inferred") continue;
      byLanguage.set(owner.language, [...(byLanguage.get(owner.language) ?? []), file]);
    }
    const findings: Finding[] = [...byLanguage].map(([language, files]) => ({
      level: "hint",
      layer: "config",
      rule: "declaration/uncovered-files",
      message: `${String(files.length)} 個 ${LANGUAGE_LABEL[language]} 檔案沒有元件涵蓋，已依副檔名套用預設標準；建議在宣告中補上元件`,
      file: files[0],
      fix: `在 ${DECLARATION_FILE} 的 components 加上涵蓋這些檔案的元件（language: ${language}）`,
    }));
    return { findings };
  },
};
