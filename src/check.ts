import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDeclaration } from "./declaration/parse.ts";
import { resolveDeclaration, type Resolution } from "./declaration/resolve.ts";
import { DECLARATION_FILE } from "./declaration/types.ts";
import type { ReportInput } from "./report/render.ts";

export interface CheckResult extends ReportInput {
  resolution?: Resolution;
}

async function readDeclaration(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, DECLARATION_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** The declaration layer of `devguard check`: parse `.devguard.yaml` and resolve it against the bundled standard. */
export async function checkDeclaration(cwd: string, today: string): Promise<CheckResult> {
  const text = await readDeclaration(cwd);
  if (text === undefined) {
    return {
      components: [],
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
  if (!parsed.declaration) return { components: [], findings: parsed.findings };
  const resolution = resolveDeclaration(parsed.declaration, today);
  return {
    standard: resolution.standard?.id,
    components: resolution.components,
    findings: [...parsed.findings, ...resolution.findings],
    resolution,
  };
}

export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
