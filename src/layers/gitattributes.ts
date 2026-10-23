import { join } from "node:path";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import { readIfExists } from "../settings/config-files.ts";
import type { CheckLayer } from "./types.ts";

export const GITATTRIBUTES = ".gitattributes";
/** SPEC §5.1: Prettier and Biome default to LF, and Spotless follows .gitattributes. */
export const EOL_RULE = "* text=auto eol=lf";

const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

/** Repo-wide settings check: `.gitattributes` must contain `* text=auto eol=lf` (SPEC §5.1). */
export const gitattributesLayer: CheckLayer = {
  id: "gitattributes",
  async run({ cwd, resolution }) {
    if (!resolution?.standard) return { findings: [] };
    const text = await readIfExists(join(cwd, GITATTRIBUTES));
    if (text?.split(/\r?\n/).some((l) => normalize(l) === EOL_RULE)) return { findings: [] };
    const repairs: Repair[] = [{ op: "line", file: GITATTRIBUTES, value: EOL_RULE }];
    return {
      findings: [
        {
          level: "error",
          layer: "config",
          rule: "settings/gitattributes-eol",
          message: `${GITATTRIBUTES} 沒有「${EOL_RULE}」`,
          file: GITATTRIBUTES,
          fix: fixText(`在 ${GITATTRIBUTES} 加上 ${EOL_RULE}`, repairs),
          repairs,
        },
      ],
    };
  },
};
