import { parse as parseToml } from "@decimalturn/toml-patch";
import { findNodeAtLocation, getNodeValue, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isNode, LineCounter, parseDocument } from "yaml";
import { compareToDefault } from "../declaration/compare.ts";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import { editFormat } from "../fix/edit.ts";
import type { Repair } from "../fix/repair.ts";
import { baseName } from "../repo/paths.ts";
import type { Finding, Level } from "../report/finding.ts";
import { at } from "./config-files.ts";
import { judgeConfigValue, setAt } from "./judge.ts";

/** The golangci config `devguard fix` creates when golangci-lint would find none. */
export const GOLANGCI_FILE = ".golangci.yml";
/** golangci-lint's config names, in the order it picks one within a directory. */
export const GOLANGCI_FILES = [".golangci.json", ".golangci.toml", ".golangci.yaml", ".golangci.yml"] as const;
export const GOMOD_FILE = "go.mod";

/** Linters golangci-lint v2 enables with `linters.default: standard` (the default). */
const V2_STANDARD = ["errcheck", "govet", "ineffassign", "staticcheck", "unused"];

export interface GoSettingsFiles {
  /** Text of the golangci config golangci-lint uses; undefined when there is none. */
  golangci?: string;
  /**
   * Repo-relative path of that config, whose extension gives its format (`.json`, `.toml`, `.yaml`, `.yml`);
   * defaults to `component.dir + GOLANGCI_FILE`.
   */
  golangciFile?: string;
  /** Text of `go.mod`; undefined when the file does not exist. */
  gomod?: string;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const strings = (v: unknown): string[] => (isStrings(v) ? v : []);

class GoReport {
  readonly findings: Finding[] = [];
  private readonly component: ResolvedComponent;

  constructor(component: ResolvedComponent) {
    this.component = component;
  }

  add(level: Level, rule: string, message: string, at: Pick<Finding, "file" | "line" | "fix" | "observed">): void {
    this.findings.push({ level, layer: "config", rule, message, component: this.component.name, ...at });
  }

  /** An error `devguard fix` resolves with `repairs`; `at.fix` is the manual instruction. */
  fixable(
    rule: string,
    message: string,
    at: Pick<Finding, "file" | "line" | "fix" | "observed">,
    repairs: Repair[],
  ): void {
    const fix = fixText(at.fix ?? "", repairs);
    this.findings.push({
      level: "error",
      layer: "config",
      rule,
      message,
      component: this.component.name,
      ...at,
      fix,
      repairs,
    });
  }

  /** The component's effective value of a standard item (default + declaration override). */
  effective(key: string): unknown {
    return this.component.effective[key]?.value;
  }

  declared(key: string): EffectiveItem | undefined {
    return this.component.effective[key];
  }

  get componentName(): string {
    return this.component.name;
  }
}

type Lines = (path: readonly string[]) => number | undefined;

/** A parsed golangci config (YAML, TOML or JSON) that answers values and, where it can, their lines by key path. */
class Golangci {
  readonly file: string;
  private readonly data: unknown;
  private readonly lineOf: Lines;

  constructor(file: string, data: unknown, lineOf: Lines) {
    this.file = file;
    this.data = data;
    this.lineOf = lineOf;
  }

  /** The file name for messages, such as `.golangci.toml`. */
  get name(): string {
    return baseName(this.file);
  }

  get(...path: string[]): unknown {
    return at(this.data, ...path);
  }

  /** Line of the deepest existing node along `path` (when the format gives one), plus where to fix it. */
  at(path: string[], fix?: string): { file: string; line?: number; fix?: string } {
    const line = this.lineOf(path);
    return line === undefined ? { file: this.file, fix } : { file: this.file, line, fix };
  }
}

/**
 * Turns a line lookup for one exact path into one that falls back to the nearest existing ancestor along `path`, so a
 * missing key still points at the table it belongs in.
 */
const withAncestorFallback =
  (lineOf: (path: readonly string[]) => number | undefined): Lines =>
  (path) => {
    for (let n = path.length; n > 0; n--) {
      const line = lineOf(path.slice(0, n));
      if (line !== undefined) return line;
    }
    return undefined;
  };

type Parsed = { config: Golangci } | { syntax: { rule: string; message: string; line?: number } };

/** A golangci config that does not parse in its format, such as `settings/golangci-toml-syntax`. */
function syntaxError(format: "YAML" | "TOML" | "JSON", name: string, reason: string, line?: number): Parsed {
  return {
    syntax: {
      rule: `settings/golangci-${format.toLowerCase()}-syntax`,
      message: `${name} 的 ${format} 語法錯誤：${reason}`,
      ...(line === undefined ? {} : { line }),
    },
  };
}

function parseYamlConfig(file: string, name: string, text: string): Parsed {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const syntax = doc.errors[0];
  if (syntax) return syntaxError("YAML", name, syntax.message, lines.linePos(syntax.pos[0]).line);
  const lineOf = withAncestorFallback((path) => {
    const node = doc.getIn(path, true);
    const offset = isNode(node) ? node.range?.[0] : undefined;
    return offset === undefined ? undefined : lines.linePos(offset).line;
  });
  return { config: new Golangci(file, doc.toJSON(), lineOf) };
}

function parseTomlConfig(file: string, name: string, text: string): Parsed {
  try {
    return { config: new Golangci(file, parseToml(text), () => undefined) };
  } catch (e) {
    const line = (e as { line?: unknown }).line;
    const reason = (e instanceof Error ? e.message : String(e)).split("\n").pop() ?? "";
    return syntaxError("TOML", name, reason, typeof line === "number" ? line : undefined);
  }
}

function parseJsonConfig(file: string, name: string, text: string): Parsed {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true });
  const error = errors[0];
  if (error || !root) {
    const reason = error ? printParseErrorCode(error.error) : "空檔案";
    return syntaxError("JSON", name, reason, lineAtOffset(text, error?.offset ?? 0));
  }
  const lineOf = withAncestorFallback((path) => {
    const node = findNodeAtLocation(root, [...path]);
    return node ? lineAtOffset(text, node.offset) : undefined;
  });
  return { config: new Golangci(file, getNodeValue(root), lineOf) };
}

const lineAtOffset = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/**
 * Reads a golangci config in the format its name says (golangci-lint reads `.json`, `.toml`, `.yaml`, `.yml`), by the
 * same extension mapping `devguard fix` edits it with. JSON is read strictly: golangci-lint allows no comments.
 */
function parseGolangci(file: string, text: string): Parsed {
  const name = baseName(file);
  switch (editFormat(file)) {
    case "toml":
      return parseTomlConfig(file, name, text);
    case "jsonc":
      return parseJsonConfig(file, name, text);
    default:
      return parseYamlConfig(file, name, text);
  }
}

function isLinterOn(config: Golangci): (name: string) => boolean {
  const base = config.get("linters", "default");
  const enabled = new Set(strings(config.get("linters", "enable")));
  const disabled = new Set(strings(config.get("linters", "disable")));
  const inBase = (name: string) =>
    base === "all" || ((base ?? "standard") === "standard" && V2_STANDARD.includes(name));
  return (name) => !disabled.has(name) && (enabled.has(name) || inBase(name));
}

function checkLinters(r: GoReport, config: Golangci): void {
  const isOn = isLinterOn(config);
  for (const name of strings(r.effective("lint.rules"))) {
    if (isOn(name)) continue;
    const file = config.file;
    r.fixable(
      "settings/golangci-linter-missing",
      `${config.name} 沒有啟用標準要求的 linter「${name}」`,
      config.at(["linters", "enable"], `在 ${file} 的 linters.enable 加上 ${name}`),
      [
        { op: "add", file, path: ["linters", "enable"], value: name },
        ...(strings(config.get("linters", "disable")).includes(name)
          ? [{ op: "remove" as const, file, path: ["linters", "disable"], value: name }]
          : []),
      ],
    );
  }
}

interface Threshold {
  linter: string;
  setting: string;
  /** The standard item the setting lands. */
  item: string;
  label: string;
  /** golangci-lint's own default. */
  toolDefault: number;
  /** The standard requires it written out, because the tool default is too loose. */
  explicit: boolean;
}

const THRESHOLDS: readonly Threshold[] = [
  {
    linter: "cyclop",
    setting: "max-complexity",
    item: "complexity.cyclomatic",
    label: "循環複雜度上限",
    toolDefault: 10,
    explicit: false,
  },
  {
    linter: "gocognit",
    setting: "min-complexity",
    item: "complexity.cognitive",
    label: "認知複雜度上限",
    toolDefault: 30,
    explicit: true,
  },
];

/** Settings-file value vs declared value, through the shared judge (SPEC §8): looser is an error, stricter a hint. */
function judgeThreshold(r: GoReport, config: Golangci, t: Threshold, actual: unknown): void {
  const path = ["linters", "settings", t.linter, t.setting];
  const { line } = config.at(path);
  const finding = judgeConfigValue({
    key: t.item,
    item: { kind: "max", label: t.label, value: r.effective(t.item) as number },
    declared: r.declared(t.item),
    actual,
    site: { component: r.componentName, file: config.file, ...(line === undefined ? {} : { line }) },
    label: `${t.linter}.${t.setting}`,
    repair: setAt(config.file, path),
    reportInvalid: true,
  });
  if (finding) r.findings.push(finding);
}

function checkThresholds(r: GoReport, config: Golangci): void {
  for (const t of THRESHOLDS) {
    const written = config.get("linters", "settings", t.linter, t.setting);
    if (written === undefined && t.explicit) {
      const declared = r.effective(t.item);
      r.fixable(
        "settings/golangci-unset",
        `${config.name} 沒有明確設定 ${t.linter}.${t.setting}（golangci-lint 預設 ${String(t.toolDefault)}）`,
        config.at(
          ["linters", "settings", t.linter],
          `在 linters.settings.${t.linter} 加上 ${t.setting}: ${String(declared)}`,
        ),
        [{ op: "set", file: config.file, path: ["linters", "settings", t.linter, t.setting], value: declared }],
      );
      continue;
    }
    judgeThreshold(r, config, t, written ?? t.toolDefault);
  }
}

function checkDepguard(r: GoReport, config: Golangci): void {
  const rules = config.get("linters", "settings", "depguard", "rules");
  if (typeof rules === "object" && rules !== null && Object.keys(rules).length > 0) return;
  const path = ["linters", "settings", "depguard", "rules"];
  const deny = strings(r.effective("deps.bannedApis")).map((pkg) => ({ pkg, desc: "標準禁用（deps.bannedApis）" }));
  r.fixable(
    "settings/golangci-depguard-rules",
    `${config.name} 的 depguard 沒有明確規則（linters.settings.depguard.rules）`,
    config.at(path, "在 linters.settings.depguard.rules 寫明禁用的套件"),
    [{ op: "set", file: config.file, path, value: { main: { deny } } }],
  );
}

function checkFormatters(r: GoReport, config: Golangci): void {
  const enabled = new Set(strings(config.get("formatters", "enable")));
  for (const name of strings(r.effective("format.tools"))) {
    if (enabled.has(name)) continue;
    r.fixable(
      "settings/golangci-formatter-missing",
      `${config.name} 沒有啟用宣告的格式化工具「${name}」`,
      config.at(["formatters", "enable"], `在 ${config.file} 的 formatters.enable 加上 ${name}`),
      [{ op: "add", file: config.file, path: ["formatters", "enable"], value: name }],
    );
  }
}

function checkGolangci(r: GoReport, file: string, text: string): void {
  const parsed = parseGolangci(file, text);
  if ("syntax" in parsed) {
    const { rule, message, line } = parsed.syntax;
    r.add("error", rule, message, { file, ...(line === undefined ? {} : { line }) });
    return;
  }
  const config = parsed.config;
  // A v1 config means other things by the same keys (`enable-all`, `linters-settings`), and v2 repairs written into
  // it give a mix golangci-lint cannot load (#86): report the version alone, like a syntax error.
  if (String(config.get("version")) !== "2") {
    r.add(
      "error",
      "settings/golangci-version",
      `${config.name} 必須是 golangci-lint v2 格式（version: "2"）；轉換之前不檢查其他設定`,
      config.at(["version"], "golangci-lint migrate，再重新執行 devguard check"),
    );
    return;
  }
  checkLinters(r, config);
  checkThresholds(r, config);
  checkDepguard(r, config);
  checkFormatters(r, config);
}

const GO_DIRECTIVE = /^\s*go\s+(\d+(?:\.\d+)*)\s*(?:\/\/.*)?$/;

/** The `go` directive of a go.mod: its version and 1-based line. */
function goDirective(text: string): { version: string; line: number } | undefined {
  for (const [i, l] of text.split(/\r?\n/).entries()) {
    const version = GO_DIRECTIVE.exec(l)?.[1];
    if (version !== undefined) return { version, line: i + 1 };
  }
  return undefined;
}

function checkGoMod(r: GoReport, file: string, text: string): void {
  const required = r.effective("go.minVersion") as string;
  const found = goDirective(text);
  if (found && compareToDefault({ kind: "minVersion", label: "", value: required }, found.version) !== "looser") return;
  r.add(
    "error",
    "settings/gomod-go-version",
    found
      ? `${GOMOD_FILE} 的 go 版本 ${found.version} 低於標準要求的 ${required}`
      : `${GOMOD_FILE} 沒有 go 版本（標準要求至少 ${required}）`,
    {
      file,
      line: found?.line,
      fix: `go mod edit -go=${required}`,
      ...(found ? { observed: { key: "go.minVersion", value: found.version } } : {}),
    },
  );
}

/** Compares a Go component's golangci config and `go.mod` with its effective standard (SPEC §6.2, §8). */
export function checkGoSettings(component: ResolvedComponent, files: GoSettingsFiles): Finding[] {
  const r = new GoReport(component);
  if (files.golangci !== undefined)
    checkGolangci(r, files.golangciFile ?? component.dir + GOLANGCI_FILE, files.golangci);
  if (files.gomod !== undefined) checkGoMod(r, component.dir + GOMOD_FILE, files.gomod);
  return r.findings;
}
