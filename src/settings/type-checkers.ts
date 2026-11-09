import { valueInForce, type Resolution, type ResolvedComponent } from "../declaration/resolve.ts";
import { parseConfigText } from "../fix/edit.ts";
import type { Printed } from "../fix/plan.ts";
import { repoReader } from "../shared/fs.ts";
import { isRecord } from "../shared/guards.ts";
import type { ItemDef } from "../standard/types.ts";
import { searchDirs } from "./config-files.ts";

/** The Python type checkers a standard may allow for `typecheck.tool` (SPEC §6.1). */
export const TYPE_CHECKERS = ["mypy", "pyright", "basedpyright"] as const;
export type TypeChecker = (typeof TYPE_CHECKERS)[number];

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
  /** It sets pyright's `typeCheckingMode = "off"`, so it checks no types (#114). */
  off: boolean;
}

/** Whether pyright-format settings turn type checking off: `typeCheckingMode = "off"` (#114). */
export function typeCheckingOff(settings: unknown): boolean {
  return isRecord(settings) && settings.typeCheckingMode === "off";
}

const OWN_FILES: readonly (readonly [string, readonly TypeChecker[]])[] = [
  ["mypy.ini", ["mypy"]],
  [".mypy.ini", ["mypy"]],
  ["pyrightconfig.json", ["pyright", "basedpyright"]],
];

/** The `[tool]` table of a parsed pyproject.toml, undefined when it has none. */
function pyprojectTool(doc: unknown): Record<string, unknown> | undefined {
  return isRecord(doc) && isRecord(doc.tool) ? doc.tool : undefined;
}

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
  const tool = pyprojectTool(doc) ?? {};
  for (const checker of TYPE_CHECKERS) {
    const table = tool[checker];
    if (!isRecord(table)) continue;
    const off = checker !== "mypy" && typeCheckingOff(table);
    configs.push({ file: pyproject, where: `[tool.${checker}]`, tools: [checker], off });
  }
  for (const [name, tools] of OWN_FILES) {
    const file = dir + name;
    const text = await read(file);
    if (text === undefined) continue;
    const off = name === "pyrightconfig.json" && typeCheckingOff(parseConfigText(name, text));
    configs.push({ file, where: name, tools, off });
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
 * `key: value` (keys lowercased), `#` / `;` comment lines and indented continuation lines. Undefined when
 * configparser (strict, as mypy uses it) rejects the text: a key before any section, a section or a key in a section
 * given twice.
 */
function iniSections(text: string): Map<string, Map<string, string>> | undefined {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: string | undefined;
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*(?:[#;].*)?$/.test(line));
  for (const line of lines) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      const name = header[1] ?? "";
      if (sections.has(name)) return undefined;
      section = new Map();
      sections.set(name, section);
      key = undefined;
      continue;
    }
    if (section === undefined) return undefined;
    key = addIniLine(section, key, line);
    if (key === undefined) return undefined;
  }
  return sections;
}

/**
 * Adds one non-header line to `section`: a continuation of `key`, or a new key. Returns the key the line went to,
 * undefined when it is not valid INI or sets a key the section already has.
 */
function addIniLine(section: Map<string, string>, key: string | undefined, line: string): string | undefined {
  if (/^\s/.test(line) && key !== undefined) {
    section.set(key, `${section.get(key) ?? ""}\n${line.trim()}`);
    return key;
  }
  const entry = /^([^=:]+)[=:](.*)$/.exec(line);
  if (!entry) return undefined;
  const name = (entry[1] ?? "").trim().toLowerCase();
  if (section.has(name)) return undefined;
  section.set(name, (entry[2] ?? "").trim());
  return name;
}

/** The settings mypy reads from one existing candidate file, or undefined when mypy skips the file. */
function mypySettings(name: string, text: string): Record<string, unknown> | undefined {
  if (name === "pyproject.toml") {
    const mypy = pyprojectTool(parseConfigText(name, text))?.mypy;
    return isRecord(mypy) ? mypy : undefined;
  }
  const sections = iniSections(text);
  if (sections === undefined) return undefined;
  const mypy = sections.get("mypy");
  // mypy.ini and .mypy.ini are used even without a [mypy] section; setup.cfg only with one.
  if (mypy === undefined) return name === "setup.cfg" ? undefined : {};
  return Object.fromEntries(mypy);
}

/** mypy's own config files, then the shared ones it reads only when they hold a mypy section (mypy's defaults.py). */
const MYPY_CONFIG_NAMES = ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"] as const;

/**
 * Whether the mypy configuration in force for component directory `dir` sets a non-empty `files` (#110). Mirrors mypy's own lookup (mypy 2.x `config_parser._find_config_file`; documented under "Config
 * file"): in the working directory it tries mypy.ini, .mypy.ini, pyproject.toml (only with `[tool.mypy]`) and
 * setup.cfg (only with `[mypy]`), takes the first, skips a file it cannot parse, and otherwise moves to the parent
 * directory until it reaches the repository root. The user-level files (~/.config/mypy/config, ~/.mypy.ini) are
 * outside the repo and not considered. `files` may be a TOML array or a comma-separated string.
 */
export async function mypyConfigSetsFiles(
  dir: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<boolean> {
  // Only the repo-relative directories are used: `read` takes repo-relative paths.
  for (const { relDir } of searchDirs("", dir)) {
    for (const name of MYPY_CONFIG_NAMES) {
      const text = await read(relDir + name);
      const settings = text === undefined ? undefined : mypySettings(name, text);
      if (settings === undefined) continue;
      const files = settings.files;
      if (typeof files === "string") return splitCommas(files).length > 0;
      return Array.isArray(files) && files.some((f) => typeof f === "string");
    }
  }
  return false;
}

/** How to declare `tool` for a component instead, or why the component's standard does not allow it yet. */
function declareInstead(tool: TypeChecker, allowed: readonly string[]): string {
  if (allowed.includes(tool)) return `typecheck.tool: ${tool}`;
  return `typecheck.tool: ${tool}（目前宣告的標準不允許，需先以 devguard standard upgrade 升級）`;
}

/** The type checker a Python component declares (`typecheck.tool` in force for it, given the standard's `item`). */
export function declaredTypeChecker(c: ResolvedComponent, item: ItemDef | undefined): string {
  const inForce = valueInForce(item?.value, c.effective["typecheck.tool"]);
  return typeof inForce === "string" ? inForce : "mypy";
}

const TYPE_CHECKER_RANGES: ReadonlySet<string> = new Set(TYPE_CHECKERS.map((tool) => `tools.${tool}`));

/**
 * Whether the version range `key` (`tools.<tool>`) applies to a component of `language` (#113): of the Python type
 * checkers only the declared one's does, since a project on basedpyright may still lock a mypy the standard's range
 * does not allow. Every other range applies.
 */
export function rangeApplies(key: string, c: ResolvedComponent, defs: Readonly<Record<string, ItemDef>>): boolean {
  if (c.language !== "python" || !TYPE_CHECKER_RANGES.has(key)) return true;
  return key === `tools.${declaredTypeChecker(c, defs["typecheck.tool"])}`;
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
    const declared = declaredTypeChecker(c, item);
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
