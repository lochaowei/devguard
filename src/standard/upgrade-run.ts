import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToolHint } from "../distribution.ts";
import { FIX_LAYERS, runCheck, type CheckOptions, type CheckResult } from "../check.ts";
import { parseDeclaration } from "../declaration/parse.ts";
import { normalizeDir } from "../declaration/path.ts";
import type { EffectiveItem, ResolvedComponent } from "../declaration/resolve.ts";
import { DECLARATION_FILE, type Declaration, type RawOverride } from "../declaration/types.ts";
import { writesItself } from "../fix/category.ts";
import { applyPlan, planChanges, renderPlan, type ChangePlan } from "../fix/plan.ts";
import type { KeyPath, Repair } from "../fix/repair.ts";
import { createDeclarationLayer, readDeclaration } from "../layers/declaration.ts";
import { rangeInForce } from "../layers/tool-versions.ts";
import type { Finding } from "../report/finding.ts";
import { pythonManager } from "../tools/python-manager.ts";
import { createToolRunner, type PackageRequest, type ToolRunner } from "../tools/runner.ts";
import { pinnedVersions, type Pinned } from "../versions/pinned.ts";
import { inRange, parseRange } from "../versions/range.ts";
import { BUNDLED_STANDARDS, compareVersion, findStandard, parseStandardId } from "./registry.ts";
import { LANGUAGE_LABEL, type ItemDef, type Language, type Standard } from "./types.ts";
import { diffStandards, newerVersions, type ItemChange } from "./upgrade.ts";
import { repoReaderSync } from "../shared/fs.ts";

export interface UpgradeOptions extends CheckOptions {
  /** `devguard standard upgrade [目標版本]`; defaults to the newest bundled version of the declared standard. */
  target?: string;
  /** `--apply`: write the changes and run the commands. Otherwise only preview. */
  apply: boolean;
  write: (text: string) => void;
  /** The standard versions this CLI bundles; tests inject their own. */
  bundled?: readonly Standard[];
}

/** An override that the target makes pointless: equal to the new default, or of an item the target dropped. */
export interface RedundantOverride {
  component: string;
  key: string;
  why: "same" | "removed";
  path: KeyPath;
}

/** A locked tool version outside the target's range, or a PATH tool whose range changed. */
export interface ToolChange {
  component: string;
  language: Language;
  dir: string;
  name: string;
  range: string;
  version?: string;
  file?: string;
}

/** A package-manager command: run through the mirror on --apply, or only printed (`request` absent). */
export interface PlannedCommand {
  display: string;
  request?: PackageRequest;
}

export interface UpgradePlan {
  from: string;
  to: string;
  items: ItemChange[];
  redundant: RedundantOverride[];
  /** Errors and deviations the project would have under the target that it does not have now. */
  newFindings: Finding[];
  tools: ToolChange[];
  commands: PlannedCommand[];
  changes: ChangePlan;
}

/** Why there is nothing to plan: `code` 0 when already up to date, 2 when the upgrade cannot be planned. */
export interface NoUpgrade {
  code: 0 | 2;
  message: string;
}

const fmt = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : JSON.stringify(v));

const scopeLabel = (scope: ItemChange["scope"]) => (scope === "global" ? "整體" : LANGUAGE_LABEL[scope]);

const findingKey = (f: Finding) => [f.level, f.rule, f.component, f.file, f.message].join("|");

interface Target {
  declaration: Declaration;
  from?: Standard;
  to: Standard;
}

async function readCurrent(cwd: string): Promise<Declaration | NoUpgrade> {
  const text = await readDeclaration(cwd);
  if (text === undefined) return { code: 2, message: `找不到 ${DECLARATION_FILE}，無法升級標準\n` };
  const { declaration } = parseDeclaration(text, DECLARATION_FILE);
  return declaration ?? { code: 2, message: `${DECLARATION_FILE} 無法解析，請先執行 devguard check\n` };
}

const isNewer = (wanted: string, current: string): boolean =>
  compareVersion(parseStandardId(wanted)?.version ?? [], parseStandardId(current)?.version ?? []) > 0;

async function chooseTarget(options: UpgradeOptions, bundled: readonly Standard[]): Promise<Target | NoUpgrade> {
  const declaration = await readCurrent(options.cwd);
  if ("code" in declaration) return declaration;
  const current = declaration.standard;
  const wanted = options.target ?? newerVersions(current, bundled)[0]?.id;
  if (wanted === undefined) return { code: 0, message: `已經是這個 devguard 內建的最新標準 ${current}\n` };
  const found = findStandard(wanted, bundled);
  if (!found.ok) return { code: 2, message: `這個 devguard 沒有內建「${wanted}」\n` };
  if (!isNewer(wanted, current)) return { code: 0, message: `已經是 ${current}，不需要升級到 ${wanted}\n` };
  const lookup = findStandard(current, bundled);
  return { declaration, from: lookup.ok ? lookup.standard : undefined, to: found.standard };
}

function sameComponent(r: ResolvedComponent) {
  return (c: { path: string; language: string }) => normalizeDir(c.path) === r.dir && c.language === r.language;
}

function redundantIn(
  overrides: readonly RawOverride[],
  defs: Readonly<Record<string, ItemDef>>,
  before: Record<string, EffectiveItem> | undefined,
  after: Record<string, EffectiveItem> | undefined,
): { key: string; why: RedundantOverride["why"] }[] {
  return overrides.flatMap(({ key }): { key: string; why: RedundantOverride["why"] }[] => {
    if (!defs[key]) return [{ key, why: "removed" }];
    const became = after?.[key]?.status === "same" && before?.[key]?.status !== "same";
    return became ? [{ key, why: "same" }] : [];
  });
}

function redundantOverrides(t: Target, before: CheckResult, after: CheckResult): RedundantOverride[] {
  const found: RedundantOverride[] = [];
  const components = after.resolution?.components ?? [];
  t.declaration.components.forEach((declared, i) => {
    const now = components.find((r) => sameComponent(r)(declared));
    if (!now) return;
    const was = before.resolution?.components.find((r) => sameComponent(r)(declared));
    for (const r of redundantIn(declared.overrides, t.to.languages[now.language], was?.effective, now.effective))
      found.push({ component: now.name, ...r, path: ["components", i, "overrides", r.key] });
  });
  const global = redundantIn(
    t.declaration.globalOverrides,
    t.to.global,
    before.resolution?.global,
    after.resolution?.global,
  );
  for (const r of global) found.push({ component: "整體", ...r, path: ["mirrors", r.key.replace(/^mirrors\./, "")] });
  return found;
}

/** One versionRange item of one component: what has to change for it. */
function toolChangesOf(
  c: ResolvedComponent,
  key: string,
  item: ItemDef,
  from: Standard | undefined,
  pinned: Pinned | undefined,
): ToolChange[] {
  const range = rangeInForce(item, c.effective[key]);
  const at = { component: c.name, language: c.language, dir: c.dir, range };
  if (item.onPath) {
    const changed = from?.languages[c.language][key]?.value !== item.value;
    return changed ? [{ ...at, name: key.replace(/^tools\./, "") }] : [];
  }
  return (item.pinnedAs ?? []).flatMap((name) => {
    const version = pinned?.versions.get(name);
    return version === undefined || inRange(version, range) ? [] : [{ ...at, name, version, file: pinned?.file }];
  });
}

function toolChanges(cwd: string, t: Target, after: CheckResult): ToolChange[] {
  return (after.resolution?.components ?? []).flatMap((c) => {
    const pinned = pinnedVersions(c.language, c.dir, repoReaderSync(cwd));
    return Object.entries(t.to.languages[c.language])
      .filter(([, item]) => item.kind === "versionRange")
      .flatMap(([key, item]) => toolChangesOf(c, key, item, t.from, pinned));
  });
}

type Managed = "python" | "typescript" | "go";

/** The package manager `standard upgrade` runs: the language's own, with Python's chosen per component. */
type Manager = "uv" | "poetry" | "npm" | "go";

/** A Go module version needs all three parts: [0, 10] → "0.10.0". */
const semver = (parts: readonly number[]) => [0, 1, 2].map((i) => parts[i] ?? 0).join(".");

/** A PEP 508 requirement, e.g. `ruff>=0.18,<0.19`: what both uv and Poetry 2 take for a range. */
const pep508 = (c: ToolChange) => `${c.name}${c.range}`;

/** An argument with shell metacharacters in double quotes, so the printed command can be pasted into a shell. */
const quoted = (arg: string) => (/[<>,\s]/.test(arg) ? `"${arg}"` : arg);

interface ManagerDef {
  command: readonly string[];
  /** The `mirrors.*` key it downloads from; absent when the project's own settings name the mirror. */
  mirror?: string;
  spec(c: ToolChange): string;
  /** Quote the printed arguments (`quoted`). */
  quote?: true;
}

/** How each package manager installs a version in a range, and which mirror it downloads from. */
const MANAGERS: Readonly<Record<Manager, ManagerDef>> = {
  uv: { command: ["uv", "add", "--dev"], mirror: "mirrors.pypi", spec: pep508, quote: true },
  // Poetry downloads from the [[tool.poetry.source]] the mirror check requires.
  poetry: { command: ["poetry", "add", "--group", "dev"], spec: pep508, quote: true },
  npm: {
    command: ["npm", "install", "--save-dev"],
    mirror: "mirrors.npm",
    spec: (c) => `${c.name}@${c.range.replaceAll(",", " ")}`,
  },
  go: {
    command: ["go", "get", "-tool"],
    mirror: "mirrors.go",
    // go get takes one version, not a range: the range's lower bound.
    spec: (c) => `${c.name}@v${semver(parseRange(c.range)?.lower?.version ?? [])}`,
  },
};

/** Changes no package manager can make: PATH tools and Java build files. */
function manualCommand(change: ToolChange): PlannedCommand {
  const how =
    change.version === undefined
      ? pathToolHint(change.name, change.range)
      : `請在 ${change.file ?? "建置檔"} 把 ${change.name} 改成 ${change.range} 內的版本`;
  return { display: `${how}（請自行執行）` };
}

interface CommandContext {
  mirrorOf: (key: string) => string;
  /** Whether a repo-relative file exists: the lockfiles that tell uv from Poetry. */
  exists: (file: string) => boolean;
}

function managerOf(language: Managed, dir: string, exists: (file: string) => boolean): Manager {
  if (language === "python") return pythonManager(dir, exists);
  return language === "typescript" ? "npm" : "go";
}

/** The command as printed: run from the component's directory, and where its packages come from. */
function displayOf(manager: ManagerDef, request: PackageRequest): string {
  const where = request.dir === "" ? "" : `cd ${request.dir.replace(/\/$/, "")} && `;
  const shown = [manager.command[0] ?? "", ...request.args].map((a) => (manager.quote ? quoted(a) : a)).join(" ");
  const from = request.mirror ?? `${request.dir}pyproject.toml 的 [[tool.poetry.source]] nexus`;
  return `${where}${shown}（鏡像：${from}）`;
}

function managerCommand(group: readonly ToolChange[], language: Managed, ctx: CommandContext) {
  const dir = group[0]?.dir ?? "";
  const name = managerOf(language, dir, ctx.exists);
  const manager = MANAGERS[name];
  const args = [...manager.command.slice(1), ...group.map((c) => manager.spec(c))];
  const request: PackageRequest = { language, ...(name === "poetry" ? { manager: name } : {}), dir, args };
  if (manager.mirror !== undefined) request.mirror = ctx.mirrorOf(manager.mirror);
  const sumdb = language === "go" ? ctx.mirrorOf("mirrors.gosumdb") : "";
  if (sumdb !== "") request.sumdb = sumdb;
  return { display: displayOf(manager, request), request };
}

const isManaged = (c: ToolChange): c is ToolChange & { language: Managed } =>
  c.version !== undefined && c.language !== "java";

function commandsFor(
  changes: readonly ToolChange[],
  global: Record<string, EffectiveItem>,
  exists: (file: string) => boolean,
): PlannedCommand[] {
  const mirrorOf = (key: string) => {
    const value = global[key]?.value;
    return typeof value === "string" ? value : "";
  };
  const groups = new Map<string, (ToolChange & { language: Managed })[]>();
  for (const change of changes.filter(isManaged)) {
    const id = `${change.language}|${change.dir}`;
    groups.set(id, [...(groups.get(id) ?? []), change]);
  }
  const managed = [...groups.values()].flatMap((group) =>
    group[0] ? [managerCommand(group, group[0].language, { mirrorOf, exists })] : [],
  );
  return [...managed, ...changes.filter((c) => !isManaged(c)).map(manualCommand)];
}

/**
 * Plans `devguard standard upgrade` (SPEC §5.5): resolves the declaration and the config checks against the current
 * and the target standard, and from the difference derives what to show and what `--apply` would do.
 */
export async function planStandardUpgrade(options: UpgradeOptions): Promise<UpgradePlan | NoUpgrade> {
  const bundled = options.bundled ?? BUNDLED_STANDARDS;
  const t = await chooseTarget(options, bundled);
  if ("code" in t) return t;
  const settings = FIX_LAYERS.filter((l) => l.id !== "declaration");
  const check = { cwd: options.cwd, today: options.today, tools: options.tools, listFiles: options.listFiles };
  const before = await runCheck(check, [createDeclarationLayer({ bundled }), ...settings]);
  const after = await runCheck(check, [createDeclarationLayer({ bundled, standard: t.to.id }), ...settings]);

  const known = new Set(before.findings.map(findingKey));
  const newFindings = after.findings.filter(
    (f) =>
      (f.level === "error" || f.level === "deviation") && !f.rule.startsWith("standard/") && !known.has(findingKey(f)),
  );
  const redundant = redundantOverrides(t, before, after);
  const declarationEdits: Repair[] = [
    { op: "set", file: DECLARATION_FILE, path: ["standard"], value: t.to.id },
    ...redundant.map((r): Repair => ({ op: "delete", file: DECLARATION_FILE, path: r.path })),
  ];
  const configRepairs = after.findings.flatMap((f) => f.repairs ?? []);
  const tools = toolChanges(options.cwd, t, after);
  const languages = (after.resolution?.components ?? []).map((c) => c.language);
  return {
    from: t.declaration.standard,
    to: t.to.id,
    items: t.from ? diffStandards(t.from, t.to, languages) : [],
    redundant,
    newFindings,
    tools,
    commands: commandsFor(tools, after.resolution?.global ?? {}, (file) => existsSync(join(options.cwd, file))),
    changes: await planChanges(options.cwd, [...declarationEdits, ...configRepairs]),
  };
}

function section(title: string, lines: readonly string[], empty: string): string[] {
  return [title, ...(lines.length === 0 ? [`  ${empty}`] : lines.map((l) => `  ${l}`)), ""];
}

function itemLine(c: ItemChange): string {
  const value =
    c.before === undefined
      ? `（新增）${fmt(c.after)}`
      : c.after === undefined
        ? `${fmt(c.before)}（移除）`
        : `${fmt(c.before)} → ${fmt(c.after)}`;
  return `${scopeLabel(c.scope)}｜${c.label}：${value}`;
}

const LEVEL_LABEL: Partial<Record<Finding["level"], string>> = { error: "錯誤", deviation: "偏離" };

function findingLine(f: Finding): string {
  const fixed = (f.repairs ?? []).some(writesItself) ? "（--apply 會修正）" : "";
  return `${LEVEL_LABEL[f.level] ?? f.level}｜${f.component ? `${f.component}｜` : ""}${f.message}${fixed}`;
}

function toolLine(c: ToolChange): string {
  if (c.version === undefined) return `${c.component}｜${c.name} 的版本範圍改為 ${c.range}`;
  return `${c.component}｜${c.name} ${c.version} 不在新的版本範圍 ${c.range} 內（${c.file ?? ""}）`;
}

/** The preview of an upgrade plan. */
export function renderUpgrade(plan: UpgradePlan): string {
  const redundant = plan.redundant.map(
    (r) => `${r.component}｜${r.key}${r.why === "removed" ? "（新標準已移除這個項目）" : "（與新預設相同）"}`,
  );
  return [
    `標準升級預覽：${plan.from} → ${plan.to}`,
    "",
    ...section(
      "標準項目的差異：",
      plan.items.map(itemLine),
      plan.from === plan.to ? "無" : "沒有差異（或目前版本已不在 CLI 中，無法比較）",
    ),
    "對本專案的影響：",
    ...section("多餘的覆寫（--apply 會從宣告中刪除）：", redundant, "無"),
    ...section("新的錯誤或偏離：", plan.newFindings.map(findingLine), "無"),
    ...section("需要調整的工具版本：", plan.tools.map(toolLine), "無"),
    ...section(
      "需要執行的套件管理指令（--apply 會透過內部鏡像執行）：",
      plan.commands.map((c) => c.display),
      "無",
    ),
    "要修改的檔案：",
    renderPlan(plan.changes),
  ].join("\n");
}

async function runCommands(tools: ToolRunner, commands: readonly PlannedCommand[], write: (t: string) => void) {
  for (const { request, display } of commands) {
    if (!request) continue;
    if (!tools.manage) throw new Error("這個工具執行器不支援套件管理指令");
    write(`執行：${display}\n`);
    const result = await tools.manage(request);
    if (result.code !== 0) throw new Error(`套件管理指令失敗：${display}\n${result.stderr}`);
  }
}

/**
 * `devguard standard upgrade [目標版本] [--apply]` (SPEC §5.5): previews by default; `--apply` writes the declaration
 * and config files, then runs the package-manager commands through the internal mirror. Never asks: a preview with
 * changes pending exits 1, so CI can tell an upgrade is due (SPEC §11). Returns the exit code.
 */
export async function runStandardUpgrade(options: UpgradeOptions): Promise<number> {
  const plan = await planStandardUpgrade(options);
  if ("code" in plan) {
    options.write(plan.message);
    return plan.code;
  }
  options.write(renderUpgrade(plan));
  if (plan.changes.writes.length === 0 && !plan.commands.some((c) => c.request)) return 0;
  if (!options.apply) {
    options.write("只預覽，沒有套用。加上 --apply 才會套用。\n");
    return 1;
  }
  await applyPlan(options.cwd, plan.changes);
  await runCommands(options.tools ?? createToolRunner({ cwd: options.cwd }), plan.commands, options.write);
  options.write("已套用。\n");
  return 0;
}
