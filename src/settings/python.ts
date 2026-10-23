import { compareToDefault } from "../declaration/compare.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
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
  private readonly file: string;

  constructor(component: ResolvedComponent, defs: Readonly<Record<string, ItemDef>>, file: string) {
    this.component = component;
    this.defs = defs;
    this.file = file;
  }

  /** The value the component's effective standard asks for. */
  want(key: string): unknown {
    return this.component.effective[key]?.value;
  }

  add(level: Level, rule: string, message: string, fix?: string, observed?: Finding["observed"]): void {
    this.findings.push({
      level,
      layer: "config",
      rule: `python-settings/${rule}`,
      message,
      component: this.component.name,
      file: this.file,
      ...(fix ? { fix } : {}),
      ...(observed ? { observed } : {}),
    });
  }

  /** Judges a tool setting against the declaration with the standard item's kind (SPEC §4.2, §8). */
  compare({ name, key, value, toolDefault }: Setting, bar?: Bar): void {
    const item = this.defs[key];
    if (!item) return;
    const declared = bar ? bar.value : this.want(key);
    const shown = toolDefault ? `未設定（${toolDefault} ${fmt(value)}）` : fmt(value);
    const basis = bar ? `專案 ${bar.source} 的` : "宣告的";
    const what = `${name} 為 ${shown}，${basis}「${item.label}」是 ${fmt(declared)}`;
    const observed = { key, value };
    switch (compareToDefault({ ...item, value: declared as ItemDef["value"] }, value)) {
      case "invalid":
        this.add("error", "invalid-setting", `${name} 的值 ${fmt(value)} 無法辨識`, "devguard fix");
        return;
      case "looser":
        this.add("error", "looser", `${what}：設定檔比宣告寬鬆`, "devguard fix", observed);
        return;
      case "stricter":
        this.add("hint", "stricter", `${what}：設定檔比宣告嚴格，建議把宣告同步成 ${fmt(value)}`, undefined, observed);
        return;
      case "different":
        this.add("error", "style-mismatch", `${what}：與宣告不一致`, "devguard fix", observed);
        return;
      default:
        return;
    }
  }
}

/** A Ruff selector covers a rule group when it is the group itself, a broader prefix of it, or ALL. */
const covers = (selector: string, group: string): boolean => selector === "ALL" || group.startsWith(selector);

function checkRuffRules(r: Report, ruff: Table, lint: Table): void {
  const extend = "extend-select" in lint || "extend-select" in ruff;
  if (extend) {
    r.add(
      "error",
      "ruff-extend-select",
      "Ruff 使用了 extend-select：請改用 lint.select 寫出完整規則組（Ruff 的預設規則會隨版本變動）",
      "devguard fix",
    );
  }
  const raw = lint.select ?? ruff.select;
  if (raw === undefined && extend) return;
  const declared = r.want("lint.rules");
  const groups = isStringArray(declared) ? declared : [];
  const select = isStringArray(raw) ? raw : [];
  const missing = groups.filter((g) => !select.some((s) => covers(s, g)));
  if (missing.length > 0) {
    r.add("error", "ruff-rules-missing", `Ruff lint.select 缺少標準規則組：${missing.join("、")}`, "devguard fix");
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
function ruffSetting(table: Table, setting: keyof typeof RUFF_DEFAULTS, key: string): Setting {
  const name = `Ruff ${setting}`;
  const value = table[setting];
  if (value === undefined) return { name, key, value: RUFF_DEFAULTS[setting], toolDefault: "Ruff 預設" };
  return { name, key, value };
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

/**
 * Checks requires-python against the standard minimum and returns the bar the other version settings must meet:
 * requires-python when it is higher than the declaration (the project wins), otherwise the declaration.
 */
function checkRequiresPython(r: Report, doc: Table): { floor?: string; bar?: Bar } {
  const spec = at(doc, "project")?.["requires-python"];
  const floor = typeof spec === "string" ? requiresPythonFloor(spec) : undefined;
  if (floor === undefined) return {};
  const declared = r.want(MIN_VERSION);
  const higher = typeof declared === "string" && compareVersion(versionParts(floor), versionParts(declared)) > 0;
  // SPEC §6.1: a higher requires-python is the project's call, not a stricter setting to sync back.
  if (higher) return { floor, bar: { value: floor, source: "requires-python" } };
  r.compare({ name: "requires-python", key: MIN_VERSION, value: floor });
  return { floor };
}

function checkPythonVersion(r: Report, doc: Table, ruff: Table | undefined): void {
  const { floor, bar } = checkRequiresPython(r, doc);
  const target = ruff?.["target-version"];
  if (ruff && target !== undefined) {
    r.compare({ name: "Ruff target-version", key: MIN_VERSION, value: fromRuffTarget(target) }, bar);
  } else if (ruff && floor === undefined) {
    r.add(
      "error",
      "target-version-missing",
      "Ruff 沒有設定 target-version，專案也沒有 requires-python 可供推定",
      "devguard fix",
    );
  }
  const mypy = at(doc, "tool", "mypy")?.python_version;
  if (mypy !== undefined) r.compare({ name: "mypy python_version", key: MIN_VERSION, value: mypy }, bar);
  const pyright = at(doc, "tool", "pyright")?.pythonVersion;
  if (pyright !== undefined) r.compare({ name: "pyright pythonVersion", key: MIN_VERSION, value: pyright }, bar);
}

/** mypy's `strict = true`, or pyright's `typeCheckingMode = "strict"`, whichever the declaration picks. */
function checkTypecheck(r: Report, doc: Table): void {
  const pyright = r.want("typecheck.tool") === "pyright";
  const section = pyright ? "pyright" : "mypy";
  const table = at(doc, "tool", section);
  if (!table) {
    r.add("error", "typecheck-missing", `pyproject.toml 沒有 [tool.${section}] 設定`, "devguard fix");
    return;
  }
  const strict = pyright ? table.typeCheckingMode === "strict" : table.strict === true;
  const name = pyright ? `pyright typeCheckingMode ${fmt(table.typeCheckingMode ?? null)}` : "mypy strict";
  r.compare({ name, key: "typecheck.strict", value: strict });
}

function checkCoverage(r: Report, doc: Table): void {
  if (at(doc, "tool", "coverage", "run")?.branch === true) return;
  r.add(
    "error",
    "coverage-branch",
    "coverage 沒有開啟 [tool.coverage.run] branch = true：標準要求行與分支覆蓋率各自達標",
    "devguard fix",
  );
}

function checkRuff(r: Report, ruff: Table): void {
  const lint = at(ruff, "lint") ?? {};
  checkRuffRules(r, ruff, lint);
  const mccabe = at(lint, "mccabe") ?? at(ruff, "mccabe") ?? {};
  r.compare(ruffSetting(mccabe, "max-complexity", "complexity.cyclomatic"));
  r.compare(ruffSetting(ruff, "line-length", "format.lineLength"));
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
  else r.add("error", "ruff-missing", "pyproject.toml 沒有 [tool.ruff] 設定", "devguard fix");
  checkPythonVersion(r, doc, ruff);
  checkTypecheck(r, doc);
  checkCoverage(r, doc);
  return r.findings;
}
