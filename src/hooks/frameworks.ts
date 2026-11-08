import { join } from "node:path";
import { isMap, isScalar, parse, parseDocument, Scalar } from "yaml";
import { editConfigText, parseConfigText } from "../fix/edit.ts";
import type { ChangePlan, FileWrite } from "../fix/plan.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { hookCommandLine, type GitHookName } from "./file.ts";
import { INSTALLED_HOOKS, installedHook, type InstalledHook } from "./location.ts";
import { readIfExists } from "../shared/fs.ts";
import { isDirectory } from "../shared/fs.ts";
import { isRecord } from "../shared/guards.ts";
import { compareVersion } from "../standard/registry.ts";

/** An existing hook framework (GLOSSARY: 既有 hook 框架) devguard injects into instead of writing hook files. */
export type HookFrameworkName = "pre-commit" | "husky" | "lefthook";

export interface HookFramework {
  name: HookFrameworkName;
  /** Repo-relative config file (pre-commit, lefthook) or hook directory (husky). */
  file: string;
}

/** The command a framework entry runs for a git hook. */
export const devguardEntry = (hook: GitHookName, command = "devguard"): string => `${command} hook git-${hook}`;

const mentions = (value: unknown, hook: GitHookName): boolean =>
  typeof value === "string" && value.includes(`hook git-${hook}`);

type Obj = Record<string, unknown>;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseYaml(text: string): unknown {
  try {
    return parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** How devguard is wired into one framework: which file holds a hook's entry, whether it is there, how to add it. */
interface Injector {
  file(framework: HookFramework, hook: GitHookName): string;
  hasEntry(text: string, hook: GitHookName, file: string): boolean;
  inject(file: string, text: string, hook: GitHookName, command: string): string;
  /** Whatever else the file needs for devguard's entries to run, applied once after injecting. */
  finish?(text: string): string;
  /** File mode to set after writing (a hook script). */
  mode?: number;
  /**
   * For frameworks whose entries only run once a separate command has written the hooks into the hooks directory
   * (SPEC §7.4, #70, #93): that command, and whether a hook file is one it wrote for the hook.
   */
  installer?: FrameworkInstaller;
}

/** The command a framework writes its hooks with, and how to recognise a hook file it wrote. */
interface FrameworkInstaller {
  command: string;
  /** Whether `installed` is the file the command writes for `hook`. */
  wroteHook(hook: GitHookName, installed: InstalledHook): boolean;
}

// --- pre-commit -------------------------------------------------------------------------------------------------

function preCommitRepo(hook: GitHookName, command: string): Obj {
  return {
    repo: "local",
    hooks: [
      {
        id: hook === "pre-commit" ? "devguard" : `devguard-${hook}`,
        name: "devguard",
        entry: devguardEntry(hook, command),
        language: "unsupported",
        pass_filenames: false,
        always_run: true,
        stages: [hook],
      },
    ],
  };
}

/**
 * The pre-commit version that knows `language: unsupported` (added in 4.4.0 as the new name for `system`). Older ones
 * reject the config without saying why; with the minimum in the config, pre-commit names the version it needs.
 */
export const PRE_COMMIT_MIN_VERSION = "4.4.0";

const MIN_VERSION_KEY = "minimum_pre_commit_version";

const versionParts = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);

/**
 * The config's `minimum_pre_commit_version` when it is missing (`found` undefined) or below `PRE_COMMIT_MIN_VERSION`;
 * undefined when it is high enough.
 */
export function staleMinimumVersion(text: string): { found?: string } | undefined {
  const config = parseYaml(text);
  const value: unknown = isRecord(config) ? config[MIN_VERSION_KEY] : undefined;
  if (typeof value !== "string" && typeof value !== "number") return {};
  const found = String(value);
  return compareVersion(versionParts(found), versionParts(PRE_COMMIT_MIN_VERSION)) < 0 ? { found } : undefined;
}

const MIN_VERSION_VALUE = `"${PRE_COMMIT_MIN_VERSION}"`;

/** A document end marker (`...`, always at column 0): a key written after it would start a second YAML document. */
const DOCUMENT_END = /^\.\.\.[ \t]*(#.*)?$/m;

/**
 * The text with `line` added as a new top-level key of its block mapping, in the file's own line ending: as the last
 * line, or just before a document end marker (`...`) when there is one.
 */
function appendTopLevel(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const end = DOCUMENT_END.exec(text);
  if (end) return `${text.slice(0, end.index)}${line}${eol}${text.slice(end.index)}`;
  const body = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
  return `${body}${line}${eol}`;
}

/**
 * The config with `PRE_COMMIT_MIN_VERSION` written in as text: over the value `node` of the existing key, or as a new
 * last line of a block mapping (`node` undefined). Undefined when neither applies.
 */
function minimumVersionTextEdit(text: string, node: unknown, flow: boolean): string | undefined {
  const range = isScalar(node) ? node.range : undefined;
  if (range && range[1] > range[0]) return text.slice(0, range[0]) + MIN_VERSION_VALUE + text.slice(range[1]);
  if (node !== undefined || flow) return undefined;
  return appendTopLevel(text, `${MIN_VERSION_KEY}: ${MIN_VERSION_VALUE}`);
}

/**
 * Raises `minimum_pre_commit_version` to `PRE_COMMIT_MIN_VERSION`, or adds it at the end of a block mapping. Only the
 * version's own text changes: the rest of the file is kept byte for byte, whatever its style. A config the text edit
 * cannot handle (an empty value, a flow mapping at the top) goes through the YAML document instead, comments kept.
 */
function requireMinimumVersion(text: string): string {
  if (!staleMinimumVersion(text)) return text;
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return text;
  const node: unknown = doc.get(MIN_VERSION_KEY, true);
  const edited = minimumVersionTextEdit(text, node, doc.contents.flow === true);
  if (edited !== undefined) return edited;
  if (isScalar(node)) node.value = PRE_COMMIT_MIN_VERSION;
  else {
    const value = new Scalar(PRE_COMMIT_MIN_VERSION);
    value.type = Scalar.QUOTE_DOUBLE;
    doc.set(MIN_VERSION_KEY, value);
  }
  return doc.toString({ lineWidth: 0 });
}

const DEFAULT_STAGES_KEY = "default_stages";

/**
 * Whether the config has no top-level `default_stages`. pre-commit then runs every hook without `stages` at every hook
 * type installed, so installing the pre-push hook type for devguard would run the project's own commit hooks on each
 * `git push` too (#95). Any value the project set, pre-push included, is its choice.
 */
function missingDefaultStages(text: string): boolean {
  const config = parseYaml(text);
  return isRecord(config) && !(DEFAULT_STAGES_KEY in config);
}

/**
 * Adds `default_stages: [pre-commit]` when the config has none, as a new top-level key of a block mapping so the rest
 * of the file is kept byte for byte; a flow mapping at the top goes through the YAML document instead. The stage name
 * `pre-commit` needs pre-commit 3.2.0 or later, which `requireMinimumVersion` already asks for.
 */
function requireDefaultStages(text: string): string {
  if (!missingDefaultStages(text)) return text;
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return text;
  if (doc.contents.flow !== true) return appendTopLevel(text, `${DEFAULT_STAGES_KEY}: [pre-commit]`);
  const stages = doc.createNode(["pre-commit"]);
  stages.flow = true;
  doc.set(DEFAULT_STAGES_KEY, stages);
  return doc.toString({ lineWidth: 0 });
}

/** What pre-commit needs to write every hook type devguard installs. */
const PRE_COMMIT_INSTALL = `pre-commit install ${INSTALLED_HOOKS.map((h) => `--hook-type ${h}`).join(" ")}`;

/** Whether `pre-commit install` has written the hook into the hooks directory. */
function preCommitWroteHook(hook: GitHookName, installed: InstalledHook): boolean {
  const text = installed.text ?? "";
  return text.includes("generated by pre-commit") && text.includes(`--hook-type=${hook}`);
}

const preCommit: Injector = {
  file: (framework) => framework.file,
  hasEntry(text, hook) {
    const config = parseYaml(text);
    const repos = isRecord(config) ? list(config.repos) : [];
    return repos.some((r) => isRecord(r) && list(r.hooks).some((h) => isRecord(h) && mentions(h.entry, hook)));
  },
  inject: (file, text, hook, command) =>
    editConfigText(file, text, [{ op: "add", path: ["repos"], value: preCommitRepo(hook, command) }]),
  finish: (text) => requireDefaultStages(requireMinimumVersion(text)),
  installer: { command: PRE_COMMIT_INSTALL, wroteHook: preCommitWroteHook },
};

/**
 * For doctor: the pre-commit config calls devguard at pre-push but sets no `default_stages`, so the project's hooks
 * without `stages` run on every `git push` once the pre-push hook type is installed (#95). `install` adds it.
 */
export const pushRunsProjectHooks = (text: string): boolean =>
  // pre-commit's `hasEntry` reads only the text; the file name is for the other frameworks.
  preCommit.hasEntry(text, "pre-push", "") && missingDefaultStages(text);

// --- husky ------------------------------------------------------------------------------------------------------

const husky: Injector = {
  file: (framework, hook) => `${framework.file}/${hook}`,
  hasEntry: (text, hook) => text.split(/\r?\n/).some((line) => mentions(line, hook)),
  inject(_file, text, hook, command) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${hookCommandLine(hook, command, { exec: false })}\n`;
  },
  mode: 0o755,
};

// --- lefthook ---------------------------------------------------------------------------------------------------

/** The config files lefthook reads (YAML, TOML, JSON / JSONC), in its own order of preference. */
const LEFTHOOK_CONFIGS = ["", ".", ".config/"].flatMap((prefix) =>
  ["yml", "yaml", "toml", "json", "jsonc"].map((ext) => `${prefix}lefthook.${ext}`),
);

/** Whether any job (including jobs inside a group) or command runs devguard for the hook. */
function lefthookRuns(jobs: unknown, commands: unknown, hook: GitHookName): boolean {
  const inJobs = list(jobs).some(
    (j) => isRecord(j) && (mentions(j.run, hook) || (isRecord(j.group) && lefthookRuns(j.group.jobs, undefined, hook))),
  );
  return inJobs || (isRecord(commands) && Object.values(commands).some((c) => isRecord(c) && mentions(c.run, hook)));
}

/** What writes lefthook's hooks into the hooks directory. */
const LEFTHOOK_INSTALL = "lefthook install";

/**
 * Whether `lefthook install` has written the hook: its script calls lefthook to run the hook, as
 * `call_lefthook run "<hook>" "$@"` (1.5 and later) or `call_lefthook "run <hook> $@"` (before 1.5).
 */
function lefthookWroteHook(hook: GitHookName, installed: InstalledHook): boolean {
  return new RegExp(`^call_lefthook "?run "?${hook}(?![\\w-])`, "m").test(installed.text ?? "");
}

const lefthook: Injector = {
  file: (framework) => framework.file,
  hasEntry(text, hook, file) {
    const config = parseConfigText(file, text);
    const section = isRecord(config) ? config[hook] : undefined;
    return isRecord(section) && lefthookRuns(section.jobs, section.commands, hook);
  },
  inject(file, text, hook, command) {
    const config = parseConfigText(file, text);
    const section = isRecord(config) ? config[hook] : undefined;
    const run = devguardEntry(hook, command);
    if (isRecord(section) && isRecord(section.commands) && section.jobs === undefined) {
      return editConfigText(file, text, [{ op: "set", path: [hook, "commands", "devguard"], value: { run } }]);
    }
    return editConfigText(file, text, [{ op: "add", path: [hook, "jobs"], value: { name: "devguard", run } }]);
  },
  installer: { command: LEFTHOOK_INSTALL, wroteHook: lefthookWroteHook },
};

const INJECTORS: Record<HookFrameworkName, Injector> = { "pre-commit": preCommit, husky, lefthook };

// --- detection and planning -------------------------------------------------------------------------------------

/** The hook framework the repo uses, if any. */
export async function detectFramework(cwd: string): Promise<HookFramework | undefined> {
  if ((await readIfExists(join(cwd, ".pre-commit-config.yaml"))) !== undefined) {
    return { name: "pre-commit", file: ".pre-commit-config.yaml" };
  }
  for (const file of LEFTHOOK_CONFIGS) {
    if ((await readIfExists(join(cwd, file))) !== undefined) return { name: "lefthook", file };
  }
  if (await isDirectory(join(cwd, ".husky"))) return { name: "husky", file: ".husky" };
  return undefined;
}

export interface FrameworkEntry {
  framework: HookFrameworkName;
  /** Repo-relative file that holds (or should hold) the hook's devguard entry. */
  file: string;
  present: boolean;
}

/** For doctor (SPEC §7.4 "已安裝"): the framework in use and whether its config calls devguard for the hook. */
export async function frameworkEntry(cwd: string, hook: GitHookName): Promise<FrameworkEntry | undefined> {
  const framework = await detectFramework(cwd);
  if (!framework) return undefined;
  const injector = INJECTORS[framework.name];
  const file = injector.file(framework, hook);
  const text = (await readIfExists(join(cwd, file))) ?? "";
  return { framework: framework.name, file, present: injector.hasEntry(text, hook, file) };
}

export interface HooksPath {
  value: string;
  /** Where it is set, e.g. `.git/config` or a global config path. */
  origin: string;
}

/** `core.hooksPath` and the config that sets it; undefined when unset. */
export async function readHooksPath(cwd: string, exec: Exec = nodeExec): Promise<HooksPath | undefined> {
  const r = await exec({ file: "git", args: ["config", "--show-origin", "--get", "core.hooksPath"], cwd });
  const [origin = "", value = ""] = r.stdout.trim().split("\t");
  if (r.code !== 0 || value === "") return undefined;
  return { value, origin: origin.replace(/^file:/, "") };
}

const NULL_DEVICE = /^(\/dev\/null|nul)$/i;

/** Whether `core.hooksPath` keeps git from running any hook. */
export const hooksDisabled = (path: HooksPath | undefined): boolean =>
  path !== undefined && NULL_DEVICE.test(path.value.trim());

const HUSKY_PATHS = new Set([".husky/_", ".husky"]);

export interface HooksPathConflict {
  /** The config file setting `core.hooksPath`, or `core.hooksPath` when the trouble is that it is unset. */
  file: string;
  message: string;
}

/**
 * A `core.hooksPath` that stops the hooks from running (SPEC §7.4): pointed at the null device, set while pre-commit
 * is the framework (pre-commit refuses to install), or not husky's directory while husky is.
 */
export async function hooksPathConflict(
  cwd: string,
  framework: HookFramework | undefined,
  exec: Exec = nodeExec,
): Promise<HooksPathConflict | undefined> {
  const path = await readHooksPath(cwd, exec);
  if (!path) {
    return framework?.name === "husky"
      ? { file: "core.hooksPath", message: "core.hooksPath 未設定，husky 的 hook 沒有安裝；請執行 npx husky" }
      : undefined;
  }
  const problem = setPathProblem(path, framework);
  if (!problem) return undefined;
  return { file: path.origin, message: `core.hooksPath = ${path.value}（設定於 ${path.origin}）：${problem}` };
}

/** What is wrong with a `core.hooksPath` that is set, given the framework in use. */
function setPathProblem(path: HooksPath, framework: HookFramework | undefined): string | undefined {
  if (hooksDisabled(path)) return "git 不會執行任何 hook；請移除這個設定";
  if (framework?.name === "pre-commit") {
    return "pre-commit 在 core.hooksPath 有設定時拒絕安裝 hook；請移除這個設定後執行 pre-commit install";
  }
  const huskyPath = HUSKY_PATHS.has(path.value.replace(/\\/g, "/").replace(/\/$/, ""));
  if (framework?.name === "husky" && !huskyPath) return "不是 husky 的 .husky/_；請執行 npx husky";
  return undefined;
}

/** Each file's content before and after adding the hooks' missing devguard entries. */
async function injectedFiles(
  cwd: string,
  framework: HookFramework,
  injector: Injector,
  hooks: readonly GitHookName[],
  command: string,
): Promise<Map<string, { before: string; after: string }>> {
  const files = new Map<string, { before: string; after: string }>();
  for (const hook of hooks) {
    const file = injector.file(framework, hook);
    const pending = files.get(file);
    const before = pending?.before ?? (await readIfExists(join(cwd, file))) ?? "";
    const current = pending?.after ?? before;
    const after = injector.hasEntry(current, hook, file) ? current : injector.inject(file, current, hook, command);
    files.set(file, { before, after });
  }
  return files;
}

/**
 * The framework edits that make each hook call devguard, plus what the framework needs to run them (pre-commit's
 * minimum version); hooks already calling it are left alone.
 */
export async function planFrameworkHooks(
  cwd: string,
  framework: HookFramework,
  hooks: readonly GitHookName[],
  command = "devguard",
): Promise<ChangePlan> {
  const injector = INJECTORS[framework.name];
  const files = await injectedFiles(cwd, framework, injector, hooks, command);
  const mode = injector.mode === undefined ? {} : { mode: injector.mode };
  const writes: FileWrite[] = [];
  for (const [file, { before, after }] of files) {
    const finished = injector.finish ? injector.finish(after) : after;
    if (finished !== before) writes.push({ file, category: "managed", before, after: finished, ...mode });
  }
  return { writes, printed: [] };
}

/** The hooks a framework has not written into the hooks directory yet, and the command that writes them. */
export interface UnwrittenHooks {
  /** The framework in use (pre-commit or lefthook). */
  framework: HookFrameworkName;
  /** The command that writes them: `pre-commit install --hook-type …` or `lefthook install`. */
  command: string;
  /** Each hook not written yet, with what is there now. Never empty. */
  hooks: ReadonlyMap<GitHookName, InstalledHook>;
}

/**
 * The hooks devguard installs that the hook framework (pre-commit, lefthook) has not written into the hooks directory
 * yet (SPEC §7.4, #70, #93): what doctor reports as `framework-not-installed` and what `install` asks to run the
 * framework's command for. Undefined when every hook is written, the framework has no such command (none, husky), the
 * repo is not a git repo, or `core.hooksPath` conflicts with the framework (`hooksPathConflict` is reported instead).
 */
export async function frameworkHooksNotInstalled(
  cwd: string,
  exec: Exec = nodeExec,
): Promise<UnwrittenHooks | undefined> {
  const framework = await detectFramework(cwd);
  const installer = framework && INJECTORS[framework.name].installer;
  if (!framework || !installer) return undefined;
  if ((await exec({ file: "git", args: ["rev-parse", "--git-dir"], cwd })).code !== 0) return undefined;
  if (await hooksPathConflict(cwd, framework, exec)) return undefined;
  const hooks = new Map<GitHookName, InstalledHook>();
  for (const hook of INSTALLED_HOOKS) {
    const installed = await installedHook(cwd, hook, exec);
    if (!installer.wroteHook(hook, installed)) hooks.set(hook, installed);
  }
  return hooks.size > 0 ? { framework: framework.name, command: installer.command, hooks } : undefined;
}
