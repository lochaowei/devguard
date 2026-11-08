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

/** `files = src, tests` as mypy splits it: comma-separated, blanks dropped. */
function splitCommas(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * The INI sections of `text` as Python's configparser reads them: `[section]` headers, `key = value` or
 * `key: value` (keys lowercased), `#` / `;` comment lines and indented continuation lines. Undefined when a key
 * appears before any section, which configparser rejects.
 */
function iniSections(text: string): Map<string, Map<string, string>> | undefined {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: string | undefined;
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*(?:[#;].*)?$/.test(line));
  for (const line of lines) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = new Map();
      sections.set(header[1] ?? "", section);
      key = undefined;
      continue;
    }
    if (section === undefined) return undefined;
    key = iniLine(section, key, line);
    if (key === undefined) return undefined;
  }
  return sections;
}

/** Adds one non-header line to `section`; returns the key it belongs to, undefined when it is not valid INI. */
function iniLine(section: Map<string, string>, key: string | undefined, line: string): string | undefined {
  if (/^\s/.test(line) && key !== undefined) {
    section.set(key, `${section.get(key) ?? ""}\n${line.trim()}`);
    return key;
  }
  const entry = /^([^=:]+)[=:](.*)$/.exec(line);
  if (!entry) return undefined;
  const name = (entry[1] ?? "").trim().toLowerCase();
  section.set(name, (entry[2] ?? "").trim());
  return name;
}

/** The settings mypy reads from one existing candidate file, or null when mypy skips the file. */
function mypySettings(name: string, text: string): Record<string, unknown> | null {
  if (name === "pyproject.toml") {
    const doc = parseConfigText(name, text);
    const tool = isRecord(doc) && isRecord(doc.tool) ? doc.tool : undefined;
    return tool !== undefined && isRecord(tool.mypy) ? tool.mypy : null;
  }
  const sections = iniSections(text);
  if (sections === undefined) return null;
  const mypy = sections.get("mypy");
  // mypy.ini and .mypy.ini are used even without a [mypy] section; setup.cfg only with one.
  if (mypy === undefined) return name === "setup.cfg" ? null : {};
  return Object.fromEntries(mypy);
}

/** mypy's own config files, then the shared ones it reads only when they hold a mypy section (mypy's defaults.py). */
const MYPY_CONFIG_NAMES = ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"] as const;

/** The parent of a normalized directory ("api/web/" -> "api/"), undefined for the repo root "". */
function parentDir(dir: string): string | undefined {
  if (dir === "") return undefined;
  const trimmed = dir.slice(0, -1);
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : trimmed.slice(0, slash + 1);
}

/**
 * The `files` that the mypy configuration in force for component directory `dir` sets, or undefined when it sets
 * none (#110). Mirrors mypy's own lookup (mypy 2.x `config_parser._find_config_file`; documented under "Config
 * file"): in the working directory it tries mypy.ini, .mypy.ini, pyproject.toml (only with `[tool.mypy]`) and
 * setup.cfg (only with `[mypy]`), takes the first, skips a file it cannot parse, and otherwise moves to the parent
 * directory until it reaches the repository root. The user-level files (~/.config/mypy/config, ~/.mypy.ini) are
 * outside the repo and not considered. `files` may be a TOML array or a comma-separated string.
 */
export async function mypyConfiguredFiles(
  dir: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<string[] | undefined> {
  for (let at: string | undefined = dir; at !== undefined; at = parentDir(at)) {
    for (const name of MYPY_CONFIG_NAMES) {
      const text = await read(at + name);
      const settings = text === undefined ? null : mypySettings(name, text);
      if (settings === null) continue;
      const files = settings.files;
      const list = Array.isArray(files) ? files.filter((f) => typeof f === "string") : undefined;
      const paths = typeof files === "string" ? splitCommas(files) : (list ?? []);
      return paths.length > 0 ? paths : undefined;
    }
  }
  return undefined;
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
