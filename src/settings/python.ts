import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { KeyPath, Repair } from "../fix/repair.ts";
import type { Finding, Level } from "../report/finding.ts";
import { compareVersion } from "../standard/registry.ts";
import { judgeConfigValue, setAt } from "./judge.ts";
import type { ItemDef } from "../standard/types.ts";
import { isRecord } from "../shared/guards.ts";

type Table = Record<string, unknown>;

/** A tool's settings kept outside the component's pyproject.toml (ruff.toml, pyrightconfig.json, a parent's). */
export interface ExternalToolConfig {
  /** Repo-relative path of the file. */
  file: string;
  /** Where the tool's table sits in that file ([] for ruff.toml / pyrightconfig.json). */
  prefix?: KeyPath;
  table: Table;
}

export interface PythonExtraConfigs {
  ruff?: ExternalToolConfig;
  pyright?: ExternalToolConfig;
}

/** A tool's settings table, the file that holds it and its key path there. */
interface ToolSection {
  file: string;
  prefix: KeyPath;
  table: Table;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const fmt = (v: unknown): string => JSON.stringify(v);

/** Reads a nested table, e.g. at(doc, "tool", "ruff", "lint"). */
function at(doc: Table, ...keys: string[]): Table | undefined {
  let cur: unknown = doc;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return isRecord(cur) ? cur : undefined;
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
  readonly findings: Finding[];
  private readonly component: ResolvedComponent;
  private readonly defs: Readonly<Record<string, ItemDef>>;
  readonly file: string;

  constructor(
    component: ResolvedComponent,
    defs: Readonly<Record<string, ItemDef>>,
    file: string,
    findings: Finding[] = [],
  ) {
    this.component = component;
    this.defs = defs;
    this.file = file;
    this.findings = findings;
  }

  /** The same report, with findings and repairs pointing at `file` (a tool config outside pyproject.toml). */
  forFile(file: string): Report {
    return file === this.file ? this : new Report(this.component, this.defs, file, this.findings);
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
      rule: `settings/${rule}`,
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

  /** Judges a tool setting against the declaration (or the project's own bar) through the shared judge (SPEC §8). */
  compare({ name, key, value, toolDefault, path, toFile }: Setting, bar?: Bar): void {
    const item = this.defs[key];
    if (!item) return;
    // Settings outside [tool.*] (requires-python) are not the CLI's to change: no repair.
    const repair = path ? setAt(this.file, path, toFile) : undefined;
    const finding = judgeConfigValue({
      key,
      item,
      declared: this.component.effective[key],
      actual: value,
      site: { component: this.component.name, file: this.file },
      label: name,
      repair,
      reportInvalid: true,
      ...(toolDefault ? { toolDefault } : {}),
      ...(bar ? { bar } : {}),
    });
    if (finding) this.findings.push(finding);
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
function checkExtendSelect(r: Report, ruff: Table, lint: Table, prefix: KeyPath, rules: RuffRules): boolean {
  const places = [
    { table: lint, path: [...prefix, "lint", "extend-select"] },
    { table: ruff, path: [...prefix, "extend-select"] },
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

function checkRuffRules(r: Report, ruff: Table, lint: Table, prefix: KeyPath): void {
  const selectPath = "select" in lint || !("select" in ruff) ? [...prefix, "lint", "select"] : [...prefix, "select"];
  const raw = lint.select ?? ruff.select;
  const select = isStringArray(raw) ? raw : [];
  const declared = r.want("lint.rules");
  const groups = isStringArray(declared) ? declared : [];
  const addAll = (values: string[]): Repair[] =>
    values.map((value) => ({ op: "add", file: r.file, path: selectPath, value }));
  const extended = checkExtendSelect(r, ruff, lint, prefix, { select, addAll, groups });
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

function checkRuffVersion(r: Report, ruff: ToolSection, floor: string | undefined, bar: Bar | undefined): void {
  const ruffReport = r.forFile(ruff.file);
  const target = ruff.table["target-version"];
  const targetPath = [...ruff.prefix, "target-version"];
  if (target !== undefined) {
    ruffReport.compare(
      {
        name: "Ruff target-version",
        key: MIN_VERSION,
        value: fromRuffTarget(target),
        path: targetPath,
        toFile: toRuffTarget,
      },
      bar,
    );
  } else if (floor === undefined) {
    const value = toRuffTarget(r.want(MIN_VERSION));
    ruffReport.fixable(
      "target-version-missing",
      "Ruff 沒有設定 target-version，專案也沒有 requires-python 可供推定",
      `設定 Ruff target-version = ${fmt(value)}`,
      [ruffReport.set(targetPath, value)],
    );
  }
}

function checkPythonVersion(r: Report, doc: Table, ruff?: ToolSection, pyright?: ToolSection): void {
  const { floor, bar } = checkRequiresPython(r, doc);
  if (ruff) checkRuffVersion(r, ruff, floor, bar);
  const mypy = at(doc, "tool", "mypy")?.python_version;
  const mypyPath = ["tool", "mypy", "python_version"];
  if (mypy !== undefined)
    r.compare({ name: "mypy python_version", key: MIN_VERSION, value: mypy, path: mypyPath }, bar);
  const pyrightVersion = pyright?.table.pythonVersion;
  if (pyright && pyrightVersion !== undefined) {
    const path = [...pyright.prefix, "pythonVersion"];
    r.forFile(pyright.file).compare(
      { name: "pyright pythonVersion", key: MIN_VERSION, value: pyrightVersion, path },
      bar,
    );
  }
}

/**
 * mypy's `strict = true`, or pyright's `typeCheckingMode = "strict"`, whichever the declaration picks. `found` is
 * the chosen tool's settings, which for pyright may be pyrightconfig.json instead of [tool.pyright].
 */
function checkTypecheck(r: Report, doc: Table, found: ToolSection | undefined): void {
  const pyright = r.want("typecheck.tool") === "pyright";
  const section = pyright ? "pyright" : "mypy";
  const option = pyright ? "typeCheckingMode" : "strict";
  const strictValue = pyright ? "strict" : true;
  if (!found) {
    const path = ["tool", section, option];
    // mypy's python_version carries python.minVersion (SPEC §6.1); a higher requires-python is the project's bar.
    const { floor, higher } = pythonFloor(r, doc);
    const version = higher ? floor : r.want(MIN_VERSION);
    const versionRepairs = pyright ? [] : [r.set(["tool", "mypy", "python_version"], version)];
    r.fixable(
      "typecheck-missing",
      `pyproject.toml 沒有 [tool.${section}] 設定`,
      `新增 [tool.${section}] ${option} = ${fmt(strictValue)}`,
      [r.set(path, strictValue), ...versionRepairs],
    );
    return;
  }
  const { table } = found;
  const strict = pyright ? table.typeCheckingMode === "strict" : table.strict === true;
  const name = pyright ? `pyright typeCheckingMode ${fmt(table.typeCheckingMode ?? null)}` : "mypy strict";
  const path = [...found.prefix, option];
  r.forFile(found.file).compare({ name, key: "typecheck.strict", value: strict, path, toFile: () => strictValue });
}

function checkCoverage(r: Report, doc: Table): void {
  const threshold = r.want("coverage.lines");
  // A threshold of 0 (legacy@1.0.0, #37) fails no total, so branch coverage need not be measured.
  if (typeof threshold === "number" && threshold <= 0) return;
  if (at(doc, "tool", "coverage", "run")?.branch === true) return;
  r.fixable(
    "coverage-branch",
    "coverage 沒有開啟 [tool.coverage.run] branch = true：標準要求行與分支覆蓋率各自達標",
    "設定 [tool.coverage.run] branch = true",
    [r.set(["tool", "coverage", "run", "branch"], true)],
  );
}

/** Test files where pytest's `assert` is how tests are written: Ruff S101 is relaxed there (SPEC §6.1). */
const TEST_FILE_PATTERNS = ["**/tests/**", "**/test_*.py"];

/** Whether the declared rule groups include S101 (assert), so test files need it relaxed. */
function wantsTestAsserts(r: Report): boolean {
  const declared = r.want("lint.rules");
  return isStringArray(declared) && declared.some((g) => covers(g, "S101"));
}

const testAssertRepairs = (r: Report, prefix: KeyPath): Repair[] =>
  TEST_FILE_PATTERNS.map((p) => r.set([...prefix, "lint", "per-file-ignores", p], ["S101"]));

/** Some per-file-ignores entry relaxes S101 (or a broader selector); devguard does not judge which files it names. */
function checkTestAsserts(r: Report, ruff: Table, lint: Table, prefix: KeyPath): void {
  if (!wantsTestAsserts(r)) return;
  const ignores = at(lint, "per-file-ignores") ?? at(ruff, "per-file-ignores") ?? {};
  if (Object.values(ignores).some((codes) => isStringArray(codes) && codes.some((c) => covers(c, "S101")))) return;
  r.fixable(
    "ruff-test-asserts",
    "Ruff 沒有在測試檔放寬 S101（assert），pytest 的每個 assert 都會被回報",
    `在 [tool.ruff.lint.per-file-ignores] 加上 ${TEST_FILE_PATTERNS.map((p) => `"${p}" = ["S101"]`).join("、")}`,
    testAssertRepairs(r, prefix),
  );
}

function checkRuff(r: Report, section: ToolSection): void {
  const { table: ruff, prefix } = section;
  const target = r.forFile(section.file);
  const lint = at(ruff, "lint") ?? {};
  checkRuffRules(target, ruff, lint, prefix);
  checkTestAsserts(target, ruff, lint, prefix);
  const mccabeTable = at(lint, "mccabe") ? "lint" : at(ruff, "mccabe") ? undefined : "lint";
  const mccabe = at(lint, "mccabe") ?? at(ruff, "mccabe") ?? {};
  const mccabePath = [...prefix, ...(mccabeTable ? [mccabeTable] : []), "mccabe", "max-complexity"];
  target.compare(ruffSetting(mccabe, "max-complexity", "complexity.cyclomatic", mccabePath));
  target.compare(ruffSetting(ruff, "line-length", "format.lineLength", [...prefix, "line-length"]));
}

/** The [tool.ruff] settings the standard asks for, written out when the section is missing. */
function newRuff(r: Report, doc: Table): Repair[] {
  const { floor, higher } = pythonFloor(r, doc);
  return [
    r.set([...RUFF, "line-length"], r.want("format.lineLength")),
    r.set([...RUFF, "target-version"], toRuffTarget(higher ? floor : r.want(MIN_VERSION))),
    r.set([...RUFF, "lint", "select"], r.want("lint.rules")),
    r.set([...RUFF, "lint", "mccabe", "max-complexity"], r.want("complexity.cyclomatic")),
    ...(wantsTestAsserts(r) ? testAssertRepairs(r, RUFF) : []),
  ];
}

/** [tool.ruff], [tool.mypy] and [tool.pyright] of pyproject.toml, or else Ruff's / pyright's settings in another file. */
function resolveSections(
  doc: Table,
  file: string,
  extra: PythonExtraConfigs = {},
): { ruff?: ToolSection; mypy?: ToolSection; pyright?: ToolSection } {
  const own = (prefix: string[]): ToolSection | undefined => {
    const table = at(doc, ...prefix);
    return table && { file, prefix, table };
  };
  const other = (c?: ExternalToolConfig): ToolSection | undefined =>
    c && { file: c.file, prefix: c.prefix ?? [], table: c.table };
  return {
    ruff: own(["tool", "ruff"]) ?? other(extra.ruff),
    mypy: own(["tool", "mypy"]),
    pyright: own(["tool", "pyright"]) ?? other(extra.pyright),
  };
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
  extra?: PythonExtraConfigs,
): Finding[] {
  const r = new Report(component, defs, file);
  const { ruff, mypy, pyright } = resolveSections(doc, file, extra);
  if (ruff) checkRuff(r, ruff);
  else r.fixable("ruff-missing", "pyproject.toml 沒有 [tool.ruff] 設定", "新增 [tool.ruff]", newRuff(r, doc));
  checkPythonVersion(r, doc, ruff, pyright);
  checkTypecheck(r, doc, r.want("typecheck.tool") === "pyright" ? pyright : mypy);
  checkCoverage(r, doc);
  return r.findings;
}
