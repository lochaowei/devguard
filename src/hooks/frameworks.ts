import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { editConfigText } from "../fix/edit.ts";
import type { ChangePlan, FileWrite } from "../fix/plan.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { readIfExists } from "../settings/config-files.ts";
import { hookCommandLine, type GitHookName } from "./file.ts";

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
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
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
  hasEntry(text: string, hook: GitHookName): boolean;
  inject(file: string, text: string, hook: GitHookName, command: string): string;
  /** File mode to set after writing (a hook script). */
  mode?: number;
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

const preCommit: Injector = {
  file: (framework) => framework.file,
  hasEntry(text, hook) {
    const config = parseYaml(text);
    const repos = isObj(config) ? list(config.repos) : [];
    return repos.some((r) => isObj(r) && list(r.hooks).some((h) => isObj(h) && mentions(h.entry, hook)));
  },
  inject: (file, text, hook, command) =>
    editConfigText(file, text, [{ op: "add", path: ["repos"], value: preCommitRepo(hook, command) }]),
};

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

/** The YAML config files lefthook reads, in its own order of preference. */
const LEFTHOOK_CONFIGS = [
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  ".config/lefthook.yml",
  ".config/lefthook.yaml",
];

/** Whether any job (including jobs inside a group) or command runs devguard for the hook. */
function lefthookRuns(jobs: unknown, commands: unknown, hook: GitHookName): boolean {
  const inJobs = list(jobs).some(
    (j) => isObj(j) && (mentions(j.run, hook) || (isObj(j.group) && lefthookRuns(j.group.jobs, undefined, hook))),
  );
  return inJobs || (isObj(commands) && Object.values(commands).some((c) => isObj(c) && mentions(c.run, hook)));
}

const lefthook: Injector = {
  file: (framework) => framework.file,
  hasEntry(text, hook) {
    const config = parseYaml(text);
    const section = isObj(config) ? config[hook] : undefined;
    return isObj(section) && lefthookRuns(section.jobs, section.commands, hook);
  },
  inject(file, text, hook, command) {
    const config = parseYaml(text);
    const section = isObj(config) ? config[hook] : undefined;
    const run = devguardEntry(hook, command);
    if (isObj(section) && isObj(section.commands) && section.jobs === undefined) {
      return editConfigText(file, text, [{ op: "set", path: [hook, "commands", "devguard"], value: { run } }]);
    }
    return editConfigText(file, text, [{ op: "add", path: [hook, "jobs"], value: { name: "devguard", run } }]);
  },
};

const INJECTORS: Record<HookFrameworkName, Injector> = { "pre-commit": preCommit, husky, lefthook };

// --- detection and planning -------------------------------------------------------------------------------------

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

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
  return { framework: framework.name, file, present: injector.hasEntry(text, hook) };
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

/** The framework edits that make each hook call devguard; hooks already calling it are left alone. */
export async function planFrameworkHooks(
  cwd: string,
  framework: HookFramework,
  hooks: readonly GitHookName[],
  command = "devguard",
): Promise<ChangePlan> {
  const injector = INJECTORS[framework.name];
  const writes = new Map<string, FileWrite>();
  for (const hook of hooks) {
    const file = injector.file(framework, hook);
    const pending = writes.get(file);
    const before = pending?.before ?? (await readIfExists(join(cwd, file))) ?? "";
    const current = pending?.after ?? before;
    if (injector.hasEntry(current, hook)) continue;
    const after = injector.inject(file, current, hook, command);
    const mode = injector.mode === undefined ? {} : { mode: injector.mode };
    writes.set(file, { file, category: "managed", before, after, ...mode });
  }
  return { writes: [...writes.values()], printed: [] };
}
