import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDeclaration } from "../declaration/parse.ts";
import { resolveDeclaration } from "../declaration/resolve.ts";
import { DECLARATION_FILE } from "../declaration/types.ts";
import type { CheckLayer } from "./types.ts";

async function readDeclaration(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, DECLARATION_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Parses `.devguard.yaml` and resolves it against the bundled standard; later layers read the resolution. */
export const declarationLayer: CheckLayer = {
  id: "declaration",
  async run({ cwd, today }) {
    const text = await readDeclaration(cwd);
    if (text === undefined) {
      return {
        findings: [
          {
            level: "error",
            layer: "config",
            rule: "declaration/missing",
            message: `找不到 ${DECLARATION_FILE}`,
            fix: `在 repo 根目錄建立 ${DECLARATION_FILE}（格式見 SPEC §4）`,
          },
        ],
      };
    }
    const parsed = parseDeclaration(text, DECLARATION_FILE);
    if (!parsed.declaration) return { findings: parsed.findings };
    const resolution = resolveDeclaration(parsed.declaration, today);
    return { findings: [...parsed.findings, ...resolution.findings], resolution };
  },
};
