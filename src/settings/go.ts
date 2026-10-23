import { isNode, LineCounter, parseDocument, type Document } from "yaml";
import { compareToDefault } from "../declaration/compare.ts";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import type { Finding, Level } from "../report/finding.ts";
import { judgeConfigValue, setAt } from "./judge.ts";

export const GOLANGCI_FILE = ".golangci.yml";
export const GOMOD_FILE = "go.mod";

/** Linters golangci-lint v2 enables with `linters.default: standard` (the default). */
const V2_STANDARD = ["errcheck", "govet", "ineffassign", "staticcheck", "unused"];

export interface GoSettingsFiles {
  /** Text of `.golangci.yml`; undefined when the file does not exist. */
  golangci?: string;
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

/** A parsed `.golangci.yml` that answers values and their line numbers by key path. */
class Golangci {
  readonly file: string;
  private readonly doc: Document;
  private readonly lines: LineCounter;

  constructor(file: string, doc: Document, lines: LineCounter) {
    this.file = file;
    this.doc = doc;
    this.lines = lines;
  }

  get(...path: string[]): unknown {
    const node: unknown = this.doc.getIn(path, true);
    return isNode(node) ? node.toJSON() : node;
  }

  /** Line of the deepest existing node along `path`, plus where to fix it. */
  at(path: string[], fix?: string): { file: string; line?: number; fix?: string } {
    for (let n = path.length; n > 0; n--) {
      const node = this.doc.getIn(path.slice(0, n), true);
      const offset = isNode(node) ? node.range?.[0] : undefined;
      if (offset !== undefined) return { file: this.file, line: this.lines.linePos(offset).line, fix };
    }
    return { file: this.file, fix };
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
      `${GOLANGCI_FILE} 沒有啟用標準要求的 linter「${name}」`,
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
        `${GOLANGCI_FILE} 沒有明確設定 ${t.linter}.${t.setting}（golangci-lint 預設 ${String(t.toolDefault)}）`,
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
    `${GOLANGCI_FILE} 的 depguard 沒有明確規則（linters.settings.depguard.rules）`,
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
      `${GOLANGCI_FILE} 沒有啟用宣告的格式化工具「${name}」`,
      config.at(["formatters", "enable"], `在 ${config.file} 的 formatters.enable 加上 ${name}`),
      [{ op: "add", file: config.file, path: ["formatters", "enable"], value: name }],
    );
  }
}

function checkGolangci(r: GoReport, file: string, text: string): void {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const syntax = doc.errors[0];
  if (syntax) {
    const line = lines.linePos(syntax.pos[0]).line;
    r.add("error", "settings/golangci-yaml-syntax", `${GOLANGCI_FILE} 的 YAML 語法錯誤：${syntax.message}`, {
      file,
      line,
    });
    return;
  }
  const config = new Golangci(file, doc, lines);
  if (String(config.get("version")) !== "2") {
    r.add(
      "error",
      "settings/golangci-version",
      `${GOLANGCI_FILE} 必須是 golangci-lint v2 格式（version: "2"）`,
      config.at(["version"], "golangci-lint migrate"),
    );
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

/** Compares a Go component's `.golangci.yml` and `go.mod` with its effective standard (SPEC §6.2, §8). */
export function checkGoSettings(component: ResolvedComponent, files: GoSettingsFiles): Finding[] {
  const r = new GoReport(component);
  if (files.golangci !== undefined) checkGolangci(r, component.dir + GOLANGCI_FILE, files.golangci);
  if (files.gomod !== undefined) checkGoMod(r, component.dir + GOMOD_FILE, files.gomod);
  return r.findings;
}
