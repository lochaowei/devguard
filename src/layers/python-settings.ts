import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@decimalturn/toml-patch";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Finding } from "../report/finding.ts";
import { at, findFirst, isRecord, parseJsonc, searchDirs } from "../settings/config-files.ts";
import { checkPyproject, type ExternalToolConfig, type PythonExtraConfigs } from "../settings/python.ts";
import type { ItemDef } from "../standard/types.ts";
import type { CheckLayer } from "./types.ts";

export const PYPROJECT = "pyproject.toml";

type Defs = Readonly<Record<string, ItemDef>>;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function parseTomlRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function findFallbackRuff(root: string, dir: string): Promise<ExternalToolConfig | undefined> {
  for (const { fsDir, relDir } of searchDirs(root, dir)) {
    const standalone = await findFirst(fsDir, ["ruff.toml", ".ruff.toml"]);
    const table = standalone && parseTomlRecord(standalone.text);
    if (standalone && table) return { file: relDir + standalone.name, prefix: [], table };
    if (relDir === dir) continue;
    const text = await readText(join(fsDir, PYPROJECT));
    const ruff = text !== undefined ? at(parseTomlRecord(text), "tool", "ruff") : undefined;
    if (isRecord(ruff)) return { file: relDir + PYPROJECT, prefix: ["tool", "ruff"], table: ruff };
  }
  return undefined;
}

async function readExtraConfigs(cwd: string, dir: string): Promise<PythonExtraConfigs> {
  const root = join(cwd, dir);
  const ruff = await findFallbackRuff(root, dir);
  const pyrightFile = await findFirst(root, ["pyrightconfig.json"], dir);
  const pyrightJson = pyrightFile && parseJsonc(pyrightFile.text);
  const pyright = pyrightFile && isRecord(pyrightJson) ? { file: pyrightFile.file, table: pyrightJson } : undefined;
  return { ...(ruff ? { ruff } : {}), ...(pyright ? { pyright } : {}) };
}

async function checkComponent(cwd: string, component: ResolvedComponent, defs: Defs): Promise<Finding[]> {
  const file = component.dir + PYPROJECT;
  const at = { level: "error", layer: "config", component: component.name, file } as const;
  const text = await readText(join(cwd, file));
  const extra = await readExtraConfigs(cwd, component.dir);
  if (text === undefined) {
    // What an empty pyproject.toml would be missing is what `fix` writes into the new file.
    const repairs = checkPyproject(component, defs, {}, file, extra).flatMap((f) => f.repairs ?? []);
    const fix = fixText(`建立 ${file}，寫入標準的 [tool.*] 設定`, repairs);
    return [{ ...at, rule: "python-settings/pyproject-missing", message: `找不到 ${file}`, fix, repairs }];
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    const message = `${file} 不是合法的 TOML：${(e as Error).message.split("\n")[0] ?? ""}`;
    return [{ ...at, rule: "python-settings/pyproject-invalid", message }];
  }
  return checkPyproject(component, defs, doc, file, extra);
}

/** Settings check for Python components: the tool settings in each component's pyproject.toml (SPEC §6.1, §8). */
export const pythonSettingsLayer: CheckLayer = {
  id: "python-settings",
  async run({ cwd, resolution }) {
    const findings: Finding[] = [];
    if (!resolution?.standard) return { findings };
    const defs = resolution.standard.languages.python;
    const python = resolution.components.filter((c) => c.language === "python");
    for (const component of python) findings.push(...(await checkComponent(cwd, component, defs)));
    return { findings };
  },
};
