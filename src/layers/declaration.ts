import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDeclaration } from "../declaration/parse.ts";
import { resolveDeclaration } from "../declaration/resolve.ts";
import { DECLARATION_FILE } from "../declaration/types.ts";
import { BUNDLED_STANDARDS } from "../standard/registry.ts";
import type { Standard } from "../standard/types.ts";
import type { CheckLayer } from "./types.ts";

export async function readDeclaration(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, DECLARATION_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export interface DeclarationLayerOptions {
  /** The standard versions this CLI bundles; tests inject their own. */
  bundled?: readonly Standard[];
  /** Resolve against this standard id instead of the declared one (`standard upgrade` previewing a target). */
  standard?: string;
}

/** Parses `.devguard.yaml` and resolves it against the bundled standard; later layers read the resolution. */
export function createDeclarationLayer(options: DeclarationLayerOptions = {}): CheckLayer {
  const bundled = options.bundled ?? BUNDLED_STANDARDS;
  return {
    id: "declaration",
    fixable: true,
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
              fix: `devguard draft（依既有的工具設定產生 ${DECLARATION_FILE} 草稿）`,
            },
          ],
        };
      }
      const parsed = parseDeclaration(text, DECLARATION_FILE);
      if (!parsed.declaration) return { findings: parsed.findings };
      const declaration = { ...parsed.declaration, standard: options.standard ?? parsed.declaration.standard };
      const resolution = resolveDeclaration(declaration, today, bundled);
      return { findings: [...parsed.findings, ...resolution.findings], resolution };
    },
  };
}

export const declarationLayer: CheckLayer = createDeclarationLayer();
