import { valueInForce, type Resolution } from "../declaration/resolve.ts";
import { parseConfigText } from "../fix/edit.ts";
import type { Printed } from "../fix/plan.ts";
import { repoReader } from "../shared/fs.ts";
import { isRecord } from "../shared/guards.ts";

/** The Python type checkers a standard may allow for `typecheck.tool` (SPEC §6.1). */
export type TypeChecker = "mypy" | "pyright" | "basedpyright";

/**
 * The pyright-based type checkers: they share pyright's settings format (`typeCheckingMode`, `pythonVersion`,
 * pyrightconfig.json) and its `--outputjson` output.
 */
export type PyrightTool = Exclude<TypeChecker, "mypy">;

/** Whether `tool` (e.g. a declared `typecheck.tool`) is a pyright-based type checker. */
export function isPyrightTool(tool: unknown): tool is PyrightTool {
  return tool === "pyright" || tool === "basedpyright";
}

/** One place a Python component configures a type checker. */
export interface TypeCheckerConfig {
  /** Repo-relative path of the file. */
  file: string;
  /** What in the file holds the settings, e.g. `[tool.basedpyright]`; the file name for a tool's own file. */
  where: string;
  /** The type checkers that read it: pyrightconfig.json is read by pyright and basedpyright alike. */
  tools: readonly TypeChecker[];
}

const PYPROJECT_TABLES: readonly TypeChecker[] = ["mypy", "pyright", "basedpyright"];

const OWN_FILES: readonly (readonly [string, readonly TypeChecker[]])[] = [
  ["mypy.ini", ["mypy"]],
  [".mypy.ini", ["mypy"]],
  ["pyrightconfig.json", ["pyright", "basedpyright"]],
];

/**
 * The type checker settings in the component directory `dir` (normalized, "" for the repo root): the `[tool.mypy]`,
 * `[tool.pyright]` and `[tool.basedpyright]` tables of its pyproject.toml, then mypy.ini / .mypy.ini and
 * pyrightconfig.json. `read` returns a repo-relative file's text, or undefined when it does not exist.
 */
export async function typeCheckerConfigs(
  dir: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<TypeCheckerConfig[]> {
  const configs: TypeCheckerConfig[] = [];
  const pyproject = `${dir}pyproject.toml`;
  const text = await read(pyproject);
  const doc = text === undefined ? undefined : parseConfigText("pyproject.toml", text);
  const tool = isRecord(doc) && isRecord(doc.tool) ? doc.tool : {};
  for (const checker of PYPROJECT_TABLES) {
    if (isRecord(tool[checker])) configs.push({ file: pyproject, where: `[tool.${checker}]`, tools: [checker] });
  }
  for (const [name, tools] of OWN_FILES) {
    const file = dir + name;
    if ((await read(file)) !== undefined) configs.push({ file, where: name, tools });
  }
  return configs;
}

/** How to declare `tool` for a component instead, or why the component's standard does not allow it yet. */
function declareInstead(tool: TypeChecker, allowed: readonly string[]): string {
  if (allowed.includes(tool)) return `typecheck.tool: ${tool}`;
  return `typecheck.tool: ${tool}（目前宣告的標準不允許，需先以 devguard standard upgrade 升級）`;
}

/**
 * What `install` warns about (#68): each type checker setting of a Python component that the declared
 * `typecheck.tool` does not read, with how to declare the configured checker instead. The declaration is left as is.
 */
export async function otherTypeCheckers(cwd: string, resolution: Resolution): Promise<Printed[]> {
  const item = resolution.standard?.languages.python["typecheck.tool"];
  const allowed = item?.allowed ?? [];
  const printed: Printed[] = [];
  for (const c of resolution.components.filter((c) => c.language === "python")) {
    const inForce = valueInForce(item?.value, c.effective["typecheck.tool"]);
    const declared = typeof inForce === "string" ? inForce : "mypy";
    for (const config of await typeCheckerConfigs(c.dir, repoReader(cwd))) {
      if (config.tools.some((t) => t === declared)) continue;
      const lines = [
        `${c.name} 宣告的 typecheck.tool 是 ${declared}，但 ${config.where} 是 ${config.tools.join(" / ")} 的設定`,
        "要改用既有的工具，請在 .devguard.yaml 這個元件的 overrides 宣告：",
        ...config.tools.map((t) => `  ${declareInstead(t, allowed)}`),
      ];
      printed.push({ file: config.file, category: "typecheck", lines });
    }
  }
  return printed;
}
