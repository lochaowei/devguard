import { compareToDefault } from "../declaration/compare.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { KeyPath, Repair } from "../fix/repair.ts";
import type { Finding, Level } from "../report/finding.ts";
import { compareVersion } from "../standard/registry.ts";
import type { ItemDef } from "../standard/types.ts";

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const fmt = (v: unknown): string => JSON.stringify(v);

/** Reads a nested table, e.g. at(doc, "tool", "ruff", "lint"). */
function at(doc: Table, ...keys: string[]): Table | undefined {
  let cur: unknown = doc;
  for (const k of keys) cur = isTable(cur) ? cur[k] : undefined;
  return isTable(cur) ? cur : undefined;
}

/** Ruff's own defaults, used when pyproject.toml leaves a setting out. */
const RUFF_DEFAULTS = { "max-complexity": 10, "line-length": 88 };

interface Setting {
  /** Where the value lives, e.g. "Ruff max-complexity". */
  name: string;
  /** The standard item it carries out. */
  key: string;
  value: unknown;
  /** Set when the file leaves the setting out and the tool's default stands in. */
  toolDefault?: string;
  /** Where `devguard fix` writes the declared value; absent for settings outside [tool.*] (not CLI-managed). */
  path?: KeyPath;
  /** The declared value as the file spells it (e.g. "3.11" → "py311"). */
  toFile?: (declared: unknown) => unknown;
}

/** What a setting is compared with when the project, not the declaration, sets the bar. */
interface Bar {
  value: unknown;
  /** e.g. "requires-python"; shown instead of the declaration. */
  source: string;
}

class Report {
  readonly findings: Finding[] = [];
  private readonly component: ResolvedComponent;
  private readonly defs: Readonly<Record<string, ItemDef>>;
  readonly file: string;

  constructor(component: ResolvedComponent, defs: Readonly<Record<string, ItemDef>>, file: string) {
    this.component = component;
    this.defs = defs;
    this.file = file;
  }

  /** The value the component's effective standard asks for. */
  want(key: string): unknown {
    return this.component.effective[key]?.value;
  }

  add(
    level: Level,
    rule: string,
    message: string,
    fix?: string,
    extra: Pick<Finding, "repairs" | "observed"> = {},
  ): void {
    const { repairs, observed } = extra;
    this.findings.push({
      level,
      layer: "config",
      rule: `python-settings/${rule}`,
      message,
      component: this.component.name,
      file: this.file,
      ...(fix ? { fix } : {}),
      ...(repairs && repairs.length > 0 ? { repairs } : {}),
      ...(observed ? { observed } : {}),
    });
  }

  /** An error `devguard fix` resolves with `repairs` (the fix text follows the file category). */
  fixable(rule: string, message: string, detail: string, repairs: Repair[], observed?: Finding["observed"]): void {
    this.add("error", rule, message, fixText(detail, repairs), { repairs, observed });
  }

  set(path: KeyPath, value: unknown): Repair {
    return { op: "set", file: this.file, path, value };
  }

  /** How a setting goes back to the declared value; settings outside [tool.*] are not the CLI's to change. */
  private putBack(
    name: string,
    declared: unknown,
    path: KeyPath | undefined,
    toFile: Setting["toFile"],
  ): { detail: string; repairs: Repair[] } {
    if (!path) return { detail: `把 ${name} 改成符合 ${fmt(declared)}（不在 [tool.*]，CLI 不修改）`, repairs: [] };
    const back = toFile ? toFile(declared) : declared;
    return { detail: `把 ${name} 改為 ${fmt(back)}`, repairs: [this.set(path, back)] };
  }

  /** Judges a tool setting against the declaration with the standard item's kind (SPEC §4.2, §8). */
  compare({ name, key, value, toolDefault, path, toFile }: Setting, bar?: Bar): void {
    const item = this.defs[key];
    if (!item) return;
    const declared = bar ? bar.value : this.want(key);
    const shown = toolDefault ? `未設定（${toolDefault} ${fmt(value)}）` : fmt(value);
    const basis = bar ? `專案 ${bar.source} 的` : "宣告的";
    const what = `${name} 為 ${shown}，${basis}「${item.label}」是 ${fmt(declared)}`;
    const { detail, repairs } = this.putBack(name, declared, path, toFile);
    const observed = { key, value };
    switch (compareToDefault({ ...item, value: declared as ItemDef["value"] }, value)) {
      case "invalid":
        this.fixable("invalid-setting", `${name} 的值 ${fmt(value)} 無法辨識`, detail, repairs);
        return;
      case "looser":
        this.fixable("looser", `${what}：設定檔比宣告寬鬆`, detail, repairs, observed);
        return;
      case "stricter":
        this.add("hint", "stricter", `${what}：設定檔比宣告嚴格，建議把宣告同步成 ${fmt(value)}`, undefined, {
          observed,
        });
        return;
      case "different":
        this.fixable("style-mismatch", `${what}：與宣告不一致`, detail, repairs, observed);
        return;
      default:
        return;
    }
  }
}

/** A Ruff selector covers a rule group when it is the group itself, a broader prefix of it, or ALL. */
const covers = (selector: string, group: string): boolean => selector === "ALL" || group.startsWith(selector);

const RUFF: KeyPath = ["tool", "ruff"];

/** Ruff's selected rule groups, where `fix` adds to them, and the groups the declaration asks for. */
interface RuffRules {
  select: string[];
  addAll(values: string[]): Repair[];
  groups: string[];
}

/** extend-select is folded into lint.select, with the declared groups it still lacks. Returns whether it was used. */
function checkExtendSelect(r: Report, ruff: Table, lint: Table, rules: RuffRules): boolean {
  const places = [
    { table: lint, path: [...RUFF, "lint", "extend-select"] },
    { table: ruff, path: [...RUFF, "extend-select"] },
  ].filter((p) => "extend-select" in p.table);
  if (places.length === 0) return false;
  const extended = places.flatMap((p) => p.table["extend-select"]).filter((v) => typeof v === "string");
  const merged = [...rules.select, ...extended];
  const repairs: Repair[] = [
    ...places.map((p): Repair => ({ op: "delete", file: r.file, path: p.path })),
    ...rules.addAll([...extended, ...rules.groups.filter((g) => !merged.some((s) => covers(s, g)))]),
  ];
  r.fixable(
    "ruff-extend-select",
    "Ruff 使用了 extend-select：請改用 lint.select 寫出完整規則組（Ruff 的預設規則會隨版本變動）",
    "把 extend-select 併入 lint.select",
    repairs,
  );
  return true;
}

function checkRuffRules(r: Report, ruff: Table, lint: Table): void {
  const selectPath = "select" in lint || !("select" in ruff) ? [...RUFF, "lint", "select"] : [...RUFF, "select"];
  const raw = lint.select ?? ruff.select;
  const select = isStringArray(raw) ? raw : [];
  const declared = r.want("lint.rules");
  const groups = isStringArray(declared) ? declared : [];
  const addAll = (values: string[]): Repair[] =>
    values.map((value) => ({ op: "add", file: r.file, path: selectPath, value }));
  const extended = checkExtendSelect(r, ruff, lint, { select, addAll, groups });
  if (raw === undefined && extended) return;
  const missing = groups.filter((g) => !select.some((s) => covers(s, g)));
  if (missing.length > 0) {
    r.fixable(
      "ruff-rules-missing",
      `Ruff lint.select 缺少標準規則組：${missing.join("、")}`,
      `在 lint.select 加上 ${missing.join("、")}`,
      addAll(missing),
    );
  }
  const extra = select.filter((s) => !groups.includes(s));
  if (extra.length > 0) {
    r.add(
      "hint",
      "ruff-rules-extra",
      `Ruff lint.select 比宣告多了：${extra.join("、")}，建議把宣告的 lint.rules 同步成設定檔的值`,
    );
  }
}

/** Reads a Ruff setting, falling back to Ruff's default when it is not set. */
function ruffSetting(table: Table, setting: keyof typeof RUFF_DEFAULTS, key: string, path: KeyPath): Setting {
  const name = `Ruff ${setting}`;
  const value = table[setting];
  if (value === undefined) return { name, key, value: RUFF_DEFAULTS[setting], toolDefault: "Ruff 預設", path };
  return { name, key, value, path };
}

const MIN_VERSION = "python.minVersion";

const versionParts = (v: string): number[] => v.split(".").map(Number);

/**
 * The lowest Python version a requires-python specifier allows, as "major.minor", e.g. ">=3.12, <4" → "3.12".
 * Undefined when no specifier gives a lower bound.
 */
export function requiresPythonFloor(spec: string): string | undefined {
  const floors = spec
    .split(",")
    .map((s) => /^\s*(?:>=|~=|==|>)\s*(\d+\.\d+)/.exec(s)?.[1])
    .filter((v) => v !== undefined);
  return floors.sort((a, b) => compareVersion(versionParts(b), versionParts(a)))[0];
}

/** Ruff's target-version ("py311") as a dotted version ("3.11"); anything else is returned as is. */
const fromRuffTarget = (v: unknown): unknown => (typeof v === "string" ? v.replace(/^py(\d)(\d+)$/, "$1.$2") : v);

/** A dotted version ("3.11") as Ruff's target-version ("py311"). */
const toRuffTarget = (v: unknown): unknown => (typeof v === "string" ? `py${v.replace(".", "")}` : v);

/** The floor of requires-python, and whether it is above the declared minimum (then the project sets the bar). */
function pythonFloor(r: Report, doc: Table): { floor?: string; higher: boolean } {
  const spec = at(doc, "project")?.["requires-python"];
  const floor = typeof spec === "string" ? requiresPythonFloor(spec) : undefined;
  const declared = r.want(MIN_VERSION);
  const higher =
    floor !== undefined &&
    typeof declared === "string" &&
    compareVersion(versionParts(floor), versionParts(declared)) > 0;
  return { floor, higher };
}

/**
 * Checks requires-python against the standard minimum and returns the bar the other version settings must meet:
 * requires-python when it is higher than the declaration (the project wins), otherwise the declaration.
 */
function checkRequiresPython(r: Report, doc: Table): { floor?: string; bar?: Bar } {
  const { floor, higher } = pythonFloor(r, doc);
  if (floor === undefined) return {};
  // SPEC §6.1: a higher requires-python is the project's call, not a stricter setting to sync back.
  if (higher) return { floor, bar: { value: floor, source: "requires-python" } };
  r.compare({ name: "requires-python", key: MIN_VERSION, value: floor });
  return { floor };
}

function checkPythonVersion(r: Report, doc: Table, ruff: Table | undefined): void {
  const { floor, bar } = checkRequiresPython(r, doc);
  const target = ruff?.["target-version"];
  const targetPath = [...RUFF, "target-version"];
  if (ruff && target !== undefined) {
    r.compare(
      {
        name: "Ruff target-version",
        key: MIN_VERSION,
        value: fromRuffTarget(target),
        path: targetPath,
        toFile: toRuffTarget,
      },
      bar,
    );
  } else if (ruff && floor === undefined) {
    const value = toRuffTarget(r.want(MIN_VERSION));
    r.fixable(
      "target-version-missing",
      "Ruff 沒有設定 target-version，專案也沒有 requires-python 可供推定",
      `設定 Ruff target-version = ${fmt(value)}`,
      [r.set(targetPath, value)],
    );
  }
  const mypy = at(doc, "tool", "mypy")?.python_version;
  const mypyPath = ["tool", "mypy", "python_version"];
  if (mypy !== undefined)
    r.compare({ name: "mypy python_version", key: MIN_VERSION, value: mypy, path: mypyPath }, bar);
  const pyright = at(doc, "tool", "pyright")?.pythonVersion;
  const pyrightPath = ["tool", "pyright", "pythonVersion"];
  if (pyright !== undefined)
    r.compare({ name: "pyright pythonVersion", key: MIN_VERSION, value: pyright, path: pyrightPath }, bar);
}

/** mypy's `strict = true`, or pyright's `typeCheckingMode = "strict"`, whichever the declaration picks. */
function checkTypecheck(r: Report, doc: Table): void {
  const pyright = r.want("typecheck.tool") === "pyright";
  const section = pyright ? "pyright" : "mypy";
  const path = pyright ? ["tool", "pyright", "typeCheckingMode"] : ["tool", "mypy", "strict"];
  const strictValue = pyright ? "strict" : true;
  const table = at(doc, "tool", section);
  if (!table) {
    r.fixable(
      "typecheck-missing",
      `pyproject.toml 沒有 [tool.${section}] 設定`,
      `新增 [tool.${section}] ${String(path[2])} = ${fmt(strictValue)}`,
      [r.set(path, strictValue)],
    );
    return;
  }
  const strict = pyright ? table.typeCheckingMode === "strict" : table.strict === true;
  const name = pyright ? `pyright typeCheckingMode ${fmt(table.typeCheckingMode ?? null)}` : "mypy strict";
  r.compare({ name, key: "typecheck.strict", value: strict, path, toFile: () => strictValue });
}

function checkCoverage(r: Report, doc: Table): void {
  if (at(doc, "tool", "coverage", "run")?.branch === true) return;
  r.fixable(
    "coverage-branch",
    "coverage 沒有開啟 [tool.coverage.run] branch = true：標準要求行與分支覆蓋率各自達標",
    "設定 [tool.coverage.run] branch = true",
    [r.set(["tool", "coverage", "run", "branch"], true)],
  );
}

function checkRuff(r: Report, ruff: Table): void {
  const lint = at(ruff, "lint") ?? {};
  checkRuffRules(r, ruff, lint);
  const mccabeTable = at(lint, "mccabe") ? "lint" : at(ruff, "mccabe") ? undefined : "lint";
  const mccabe = at(lint, "mccabe") ?? at(ruff, "mccabe") ?? {};
  const mccabePath = [...RUFF, ...(mccabeTable ? [mccabeTable] : []), "mccabe", "max-complexity"];
  r.compare(ruffSetting(mccabe, "max-complexity", "complexity.cyclomatic", mccabePath));
  r.compare(ruffSetting(ruff, "line-length", "format.lineLength", [...RUFF, "line-length"]));
}

/** The [tool.ruff] settings the standard asks for, written out when the section is missing. */
function newRuff(r: Report, doc: Table): Repair[] {
  const { floor, higher } = pythonFloor(r, doc);
  return [
    r.set([...RUFF, "line-length"], r.want("format.lineLength")),
    r.set([...RUFF, "target-version"], toRuffTarget(higher ? floor : r.want(MIN_VERSION))),
    r.set([...RUFF, "lint", "select"], r.want("lint.rules")),
    r.set([...RUFF, "lint", "mccabe", "max-complexity"], r.want("complexity.cyclomatic")),
  ];
}

/**
 * Compares a parsed pyproject.toml with a Python component's effective standard (SPEC §6.1, §8).
 * A setting looser than the declaration is an error; a stricter one is a hint.
 * `defs` are the standard's Python items, which give each setting its kind.
 */
export function checkPyproject(
  component: ResolvedComponent,
  defs: Readonly<Record<string, ItemDef>>,
  doc: Table,
  file: string,
): Finding[] {
  const r = new Report(component, defs, file);
  const ruff = at(doc, "tool", "ruff");
  if (ruff) checkRuff(r, ruff);
  else r.fixable("ruff-missing", "pyproject.toml 沒有 [tool.ruff] 設定", "新增 [tool.ruff]", newRuff(r, doc));
  checkPythonVersion(r, doc, ruff);
  checkTypecheck(r, doc);
  checkCoverage(r, doc);
  return r.findings;
}
