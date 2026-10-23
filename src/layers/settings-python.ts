import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@decimalturn/toml-patch";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Finding } from "../report/finding.ts";
import { checkPyproject } from "../settings/python.ts";
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

async function checkComponent(cwd: string, component: ResolvedComponent, defs: Defs): Promise<Finding[]> {
  const file = component.dir + PYPROJECT;
  const at = { level: "error", layer: "config", component: component.name, file } as const;
  const text = await readText(join(cwd, file));
  if (text === undefined) {
    // What an empty pyproject.toml would be missing is what `fix` writes into the new file.
    const repairs = checkPyproject(component, defs, {}, file).flatMap((f) => f.repairs ?? []);
    const fix = fixText(`建立 ${file}，寫入標準的 [tool.*] 設定`, repairs);
    return [{ ...at, rule: "settings/pyproject-missing", message: `找不到 ${file}`, fix, repairs }];
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    const message = `${file} 不是合法的 TOML：${(e as Error).message.split("\n")[0] ?? ""}`;
    return [{ ...at, rule: "settings/pyproject-invalid", message }];
  }
  return checkPyproject(component, defs, doc, file);
}

/** Settings check for Python components: the tool settings in each component's pyproject.toml (SPEC §6.1, §8). */
export const pythonSettingsLayer: CheckLayer = {
  id: "settings-python",
  fixable: true,
  async run({ cwd, resolution }) {
    const findings: Finding[] = [];
    if (!resolution?.standard) return { findings };
    const defs = resolution.standard.languages.python;
    const python = resolution.components.filter((c) => c.language === "python");
    for (const component of python) findings.push(...(await checkComponent(cwd, component, defs)));
    return { findings };
  },
};
