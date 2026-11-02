import { parseConfigText } from "../fix/edit.ts";
import { isRecord } from "../shared/guards.ts";

/** The Python type checkers a standard may allow for `typecheck.tool` (SPEC §6.1). */
export type TypeChecker = "mypy" | "pyright" | "basedpyright";

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
