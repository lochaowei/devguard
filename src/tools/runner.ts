import { pathToolHint } from "../distribution.ts";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Language } from "../standard/types.ts";
import { nodeExec, type Command, type EnvVars, type Exec } from "../process/exec.ts";
import { goEnv } from "./go-env.ts";
import { PYTHON_MANAGERS, pythonManager, type PythonManager } from "./python-manager.ts";
import { isEnoent, readIfExistsSync } from "../shared/fs.ts";
import { pyName, pyprojectDependencies } from "../deps/manifests.ts";
import { typescriptInstall } from "./typescript-install.ts";

export interface ToolRequest {
  language: Language;
  /**
   * Tool name, e.g. "ruff", "eslint", "golangci-lint". For Go, a `tool` path from go.mod or its last segment,
   * or "go" itself (e.g. `go mod tidy -diff`).
   * For Java, the build wrapper to run, "mvnw" or "gradlew" (pass the plugin goal or task in `args`).
   */
  tool: string;
  /** Component directory, normalized ("" for the repo root, otherwise ending in "/"). The tool runs there. */
  dir: string;
  args?: readonly string[];
  /** Fed to the tool's stdin, e.g. the staged version of a file (SPEC §7.4). */
  stdin?: string;
  /**
   * Python only: the standard's version range of the tool (`tools.<tool>`). When the tool is missing and no
   * pyproject.toml lists it, the install hint adds it to the dev dependencies in this range (#68).
   */
  range?: string;
  /**
   * TypeScript only: the component's `deps.manager`. When the tool is missing and no lockfile says how the packages
   * are installed, the install hint uses this manager (#117).
   */
  manager?: string;
}

/**
 * A run of the Python `tool` in a component's directory, with the standard's range of it (`tools.<tool>`) for the
 * install hint when it is missing (#68). Tools the standard does not pin (e.g. `coverage`) get no range.
 */
export function pythonToolRequest(
  component: { dir: string; effective: Readonly<Record<string, unknown>> },
  tool: string,
): Omit<ToolRequest, "args"> {
  const range = component.effective[`tools.${tool}`];
  return { language: "python", tool, dir: component.dir, ...(typeof range === "string" ? { range } : {}) };
}

/** A run of the TypeScript `tool` in a component's directory, with its `deps.manager` for the install hint (#117). */
export function typescriptToolRequest(
  component: { dir: string; effective: Readonly<Record<string, unknown>> },
  tool: string,
): Omit<ToolRequest, "args"> {
  const manager = component.effective["deps.manager"];
  return { language: "typescript", tool, dir: component.dir, ...(typeof manager === "string" ? { manager } : {}) };
}

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The lines of a tool's output fit for a finding message (#128): colour and other terminal control sequences
 * removed (Vitest colours even when not writing to a terminal), and lines left blank dropped.
 */
export function toolOutputLines(text: string): string[] {
  return stripVTControlCharacters(text)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

/** The lines of what a failed tool said: its stderr, or its stdout when stderr has nothing to show. */
export function toolErrorLines(result: ToolResult): string[] {
  const stderr = toolOutputLines(result.stderr);
  return stderr.length > 0 ? stderr : toolOutputLines(result.stdout);
}

/** A command of the component's package manager (uv, npm, go), e.g. `devguard standard upgrade --apply`. */
export interface PackageRequest {
  language: Language;
  /** Python only: the component's manager (`pythonManager`); uv when absent. */
  manager?: PythonManager;
  /** Component directory, normalized as in ToolRequest. */
  dir: string;
  args: readonly string[];
}

/** Runs the project's own pinned tools (SPEC §5.2). `run` never installs or downloads anything. */
export interface ToolRunner {
  /** Throws ToolMissingError when the tool is not installed in the project environment. */
  run(request: ToolRequest): Promise<ToolResult>;
  /**
   * Runs a package-manager command, which downloads from wherever the developer's own configuration points it. Throws
   * for Java, whose build files are only ever edited by hand (SPEC §9.2). Absent on fakes that never need it.
   */
  manage?(request: PackageRequest): Promise<ToolResult>;
}

/** The tool is not installed. The CLI reports it and exits 2 (SPEC §11). */
export class ToolMissingError extends Error {
  readonly install: string;

  constructor(message: string, install: string) {
    super(message);
    this.name = "ToolMissingError";
    this.install = install;
  }

  report(): string {
    return `${this.message}\n  安裝：${this.install.replaceAll("\n", "\n    ")}\n`;
  }
}

export interface ToolRunnerDeps {
  /** Repo root. */
  cwd: string;
  exec?: Exec;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** File contents, or undefined when the file does not exist. */
  readText?: (path: string) => string | undefined;
  /** PATH, for tools the developer installs rather than the project (golangci-lint, launchers). */
  pathEnv?: string;
  /** The process environment, e.g. `UV_PROJECT_ENVIRONMENT`; `process.env` when absent. */
  processEnv?: EnvVars;
}

type Resolved = { ok: true; command: Command } | { ok: false; message: string; install: string };

interface Env {
  path: typeof win32;
  windows: boolean;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  pathEnv: string;
  vars: EnvVars;
}

/**
 * What git exports to a hook to locate the repo (githooks(5)). A project tool must not inherit them: in a worktree
 * GIT_DIR is absolute, so a project test's `git init` in a temporary directory would commit into the outer repo
 * (SPEC §7.4, #59). devguard's own git commands do not go through the runner and keep them.
 */
const GIT_REPO_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
];

/**
 * How to install uv. `pip install uv` puts it in the Python Scripts directory, which is not on PATH by default, so the
 * hint also covers an installed uv the CLI cannot see (#67).
 */
const UV_INSTALL = [
  "任選一種方式安裝 uv：",
  "官方安裝腳本（macOS / Linux）：curl -LsSf https://astral.sh/uv/install.sh | sh",
  '官方安裝腳本（Windows）：powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  "pipx install uv",
  "pip install uv",
  "scoop install uv（Windows）",
  "已用 pip 安裝仍找不到 uv 時，把 Python 的 Scripts 目錄（Windows）或 ~/.local/bin（其他平台）加進 PATH，再以 uv --version 確認",
].join("\n");

/** Programs the CLI starts by name, with the install hint shown when they are missing. A hint may span lines. */
const LAUNCHERS: Readonly<Record<string, string>> = {
  uv: UV_INSTALL,
  poetry: "scoop install poetry",
  go: "scoop install go",
};

function inDir(dir: string, command: string): string {
  return dir === "" ? command : `cd ${dir.replace(/\/$/, "")} && ${command}`;
}

/** `dir` and each ancestor directory up to the repo root `root`, nearest first. */
function searchDirs(root: string, dir: string, path: typeof win32): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((_, i) => path.join(root, ...parts.slice(0, parts.length - i))).concat(root);
}

/** The manager of the Python component at `dir` (`pythonManager`), its lockfiles looked up under the repo `root`. */
function managerAt(dir: string, root: string, env: Env): PythonManager {
  return pythonManager(dir, (file) => env.exists(env.path.join(root, file)));
}

/**
 * The project environment directories to look in, nearest first. A uv project reads `UV_PROJECT_ENVIRONMENT` as uv
 * does: an absolute path as is, a relative one against the project directory; `.venv` when unset. Poetry ignores it.
 */
function projectEnvironments(manager: PythonManager, dirs: readonly string[], env: Env): string[] {
  const configured = manager === "uv" ? env.vars.UV_PROJECT_ENVIRONMENT : undefined;
  if (configured && env.path.isAbsolute(configured)) return [env.path.normalize(configured)];
  return dirs.map((d) => env.path.join(d, configured || ".venv"));
}

/** Whether a pyproject.toml of the component or a directory above it lists `tool`; undefined when there is none. */
function listedInPyproject(tool: string, dirs: readonly string[], env: Env): boolean | undefined {
  const texts = dirs.flatMap((d) => env.readText(env.path.join(d, "pyproject.toml")) ?? []);
  if (texts.length === 0) return undefined;
  return texts.some((t) => pyprojectDependencies(t, "pyproject.toml").some((d) => pyName(d.name) === pyName(tool)));
}

/**
 * How to get a missing Python tool: the manager's install when a pyproject.toml lists it (or there is no range to
 * add it in), otherwise adding it to the dev dependencies the way `standard upgrade` does (#68), after what puts the
 * environment where devguard looks for the tool (Poetry's `virtualenvs.in-project`).
 */
function pythonInstall(req: ToolRequest, dirs: readonly string[], env: Env, name: PythonManager): string {
  const manager = PYTHON_MANAGERS[name];
  if (req.range === undefined || listedInPyproject(req.tool, dirs, env) !== false) return manager.install;
  const add = [manager.program, ...manager.addDev, `"${req.tool}${req.range}"`].join(" ");
  return manager.inProject === undefined ? add : `${manager.inProject} && ${add}`;
}

/**
 * The tool in the project environment (`projectEnvironments`). A uv project runs it through `uv run --no-sync`; a
 * Poetry project runs the executable directly, which needs Poetry's environment inside the project
 * (`virtualenvs.in-project`).
 */
function python(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const name = managerAt(req.dir, dirs.at(-1) ?? "", env);
  const manager = PYTHON_MANAGERS[name];
  const environments = projectEnvironments(name, dirs, env);
  const bin = environments
    .map((e) => (env.windows ? env.path.join(e, "Scripts", `${req.tool}.exe`) : env.path.join(e, "bin", req.tool)))
    .find((p) => env.exists(p));
  if (!bin) {
    const install = inDir(req.dir, pythonInstall(req, dirs, env, name));
    return { ok: false, message: `找不到 ${req.tool}：專案環境（${environments.join("、")}）中沒有安裝`, install };
  }
  return { ok: true, command: { ...manager.runTool(bin, req.tool, req.args ?? []), cwd } };
}

function typescript(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  // npm, pnpm and Yarn write a `.cmd` shim on Windows; Bun 1.x writes `.exe` (and `.bunx`), checked on 1.4.4 (#122).
  // The nearest directory wins; within one, `.cmd` does, as before.
  const names = env.windows ? [".cmd", ".exe"].map((ext) => req.tool + ext) : [req.tool];
  const bin = dirs
    .flatMap((d) => names.map((name) => env.path.join(d, "node_modules", ".bin", name)))
    .find((p) => env.exists(p));
  if (!bin) {
    const root = dirs.at(-1) ?? "";
    const how = typescriptInstall(req.dir, req.manager, (file) => env.readText(env.path.join(root, file)));
    return { ok: false, message: `找不到 ${req.tool}：node_modules 中沒有安裝`, install: inDir(how.dir, how.command) };
  }
  return { ok: true, command: { file: bin, args: [...(req.args ?? [])], cwd } };
}

/** `tool` directives in go.mod, both single-line and block form. */
function goModTools(text: string): string[] {
  const tools: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (inBlock) {
      if (line === ")") inBlock = false;
      else if (line !== "") tools.push(line);
    } else if (line === "tool (") inBlock = true;
    else if (line.startsWith("tool ")) tools.push(line.slice(5).trim());
  }
  return tools;
}

function onPath(name: string, env: Env): string | undefined {
  const dirs = env.pathEnv.split(env.windows ? ";" : ":").filter((d) => d !== "");
  const names = env.windows ? [".exe", ".cmd", ".bat"].map((ext) => name + ext) : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = env.path.join(dir, n);
      if (env.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function go(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const args = req.args ?? [];
  // GOPROXY=off: running a check must never download modules.
  const offline = goEnv({ offline: true });
  // `go` itself, for module commands such as `go mod tidy -diff`.
  if (req.tool === "go") return { ok: true, command: { file: "go", args: [...args], cwd, env: offline } };
  if (req.tool === "golangci-lint") {
    // Exception in SPEC §5.2: not a go.mod tool, but a binary the developer puts on PATH.
    const exe = onPath(req.tool, env);
    if (!exe) return { ok: false, message: "找不到 golangci-lint", install: pathToolHint("golangci-lint") };
    return { ok: true, command: { file: exe, args: [...args], cwd, env: goEnv() } };
  }
  const goMod = env.readText(env.path.join(cwd, "go.mod"));
  const declared = goModTools(goMod ?? "").some((t) => t === req.tool || t.endsWith(`/${req.tool}`));
  if (!declared) {
    const where = goMod === undefined ? "找不到 go.mod" : "go.mod 中沒有對應的 tool 指令";
    return {
      ok: false,
      message: `找不到 ${req.tool}：${where}`,
      install: inDir(req.dir, `go get -tool <${req.tool} 的套件路徑>`),
    };
  }
  return { ok: true, command: { file: "go", args: ["tool", req.tool, ...args], cwd, env: offline } };
}

/** The Java build wrappers by `ToolRequest.tool`: the script per platform, and how to add a missing one. */
const JAVA_WRAPPERS: Readonly<Record<string, { label: string; windows: string; posix: string; install: string }>> = {
  mvnw: { label: "Maven", windows: "mvnw.cmd", posix: "mvnw", install: "mvn -N wrapper:wrapper" },
  gradlew: { label: "Gradle", windows: "gradlew.bat", posix: "gradlew", install: "gradle wrapper" },
};

/** Only the wrapper asked for: Maven arguments must never reach gradlew, nor Gradle tasks mvnw (#96). */
function java(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const kind = JAVA_WRAPPERS[req.tool];
  if (!kind) throw new Error(`Java 工具必須是 mvnw 或 gradlew：${req.tool}`);
  const name = env.windows ? kind.windows : kind.posix;
  const wrapper = dirs.map((d) => env.path.join(d, name)).find((w) => env.exists(w));
  if (!wrapper) {
    return {
      ok: false,
      message: `找不到 ${req.tool}：沒有 ${kind.label} wrapper（${kind.posix} / ${kind.windows}）`,
      install: inDir(req.dir, kind.install),
    };
  }
  return { ok: true, command: { file: wrapper, args: [...(req.args ?? [])], cwd } };
}

const RESOLVERS: Readonly<Record<Language, (req: ToolRequest, dirs: readonly string[], env: Env) => Resolved>> = {
  python,
  typescript,
  go,
  java,
};

/** The package manager of a language; it reads its package source from the developer's own configuration. */
function packageManager(req: PackageRequest, cwd: string, env: Env): Resolved {
  const args = [...req.args];
  switch (req.language) {
    case "python":
      return { ok: true, command: { file: PYTHON_MANAGERS[req.manager ?? "uv"].program, args, cwd } };
    case "typescript": {
      const npm = onPath("npm", env);
      if (!npm) return { ok: false, message: "找不到 npm", install: "scoop install nodejs-lts" };
      return { ok: true, command: { file: npm, args, cwd } };
    }
    case "go":
      return { ok: true, command: { file: "go", args, cwd, env: goEnv() } };
    case "java":
      throw new Error("Java 的建置檔只印出修改內容，不由 CLI 執行套件管理指令");
  }
}

/** Resolves each tool to the project's pinned copy (`uv run`, `node_modules/.bin`, `go tool`, wrapper) and runs it. */
export function createToolRunner(deps: ToolRunnerDeps): Required<ToolRunner> {
  const windows = (deps.platform ?? process.platform) === "win32";
  const env: Env = {
    path: windows ? win32 : posix,
    windows,
    exists: deps.exists ?? existsSync,
    readText: deps.readText ?? readIfExistsSync,
    pathEnv: deps.pathEnv ?? process.env.PATH ?? "",
    vars: deps.processEnv ?? process.env,
  };
  const exec = deps.exec ?? nodeExec;
  const dirOf = (dir: string) => env.path.join(deps.cwd, dir.replace(/\/$/, ""));
  const start = async (resolved: Resolved, stdin?: string) => {
    if (!resolved.ok) throw new ToolMissingError(resolved.message, resolved.install);
    try {
      const command = { ...resolved.command, unsetEnv: GIT_REPO_ENV };
      return await exec(stdin === undefined ? command : { ...command, stdin });
    } catch (e) {
      const install = LAUNCHERS[resolved.command.file];
      if (isEnoent(e) && install) throw new ToolMissingError(`找不到 ${resolved.command.file}`, install);
      throw e;
    }
  };
  return {
    run: (req) => start(RESOLVERS[req.language](req, searchDirs(deps.cwd, req.dir, env.path), env), req.stdin),
    async manage(req) {
      return await start(packageManager(req, dirOf(req.dir), env));
    },
  };
}
