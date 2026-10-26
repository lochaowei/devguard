import { pathToolHint } from "../distribution.ts";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Language } from "../standard/types.ts";
import { nodeExec, type Command, type Exec } from "../process/exec.ts";
import { goEnv } from "./go-env.ts";
import { isEnoent, readIfExistsSync } from "../shared/fs.ts";

export interface ToolRequest {
  language: Language;
  /**
   * Tool name, e.g. "ruff", "eslint", "golangci-lint". For Go, a `tool` path from go.mod or its last segment,
   * or "go" itself (e.g. `go mod tidy -diff`).
   * Ignored for Java, which always runs the project's build wrapper (pass the plugin goal in `args`).
   */
  tool: string;
  /** Component directory, normalized ("" for the repo root, otherwise ending in "/"). The tool runs there. */
  dir: string;
  args?: readonly string[];
  /**
   * Extra environment variables. Go only, e.g. the mirror's GOPROXY / GOSUMDB (SPEC §10.2); the runner still
   * forces GOTOOLCHAIN=local, and GOPROXY=off for `go` / `go tool` so resolving a tool never downloads it.
   */
  env?: Readonly<Record<string, string>>;
  /** Fed to the tool's stdin, e.g. the staged version of a file (SPEC §7.4). */
  stdin?: string;
}

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A command of the component's package manager (uv, npm, go), e.g. `devguard standard upgrade --apply`. */
export interface PackageRequest {
  language: Language;
  /** Component directory, normalized as in ToolRequest. */
  dir: string;
  args: readonly string[];
  /** The internal mirror (`mirrors.pypi` / `mirrors.npm` / `mirrors.go`): the only place packages come from. */
  mirror: string;
  /** Go only: the checksum database mirror (`mirrors.gosumdb`). */
  sumdb?: string;
}

/** Runs the project's own pinned tools (SPEC §5.2). `run` never installs or downloads anything. */
export interface ToolRunner {
  /** Throws ToolMissingError when the tool is not installed in the project environment. */
  run(request: ToolRequest): Promise<ToolResult>;
  /**
   * Runs a package-manager command that downloads only through the internal mirror. Throws when there is no mirror,
   * or for Java, whose build files are only ever edited by hand (SPEC §9.2). Absent on fakes that never need it.
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
    return `${this.message}\n  安裝：${this.install}\n`;
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
}

type Resolved = { ok: true; command: Command } | { ok: false; message: string; install: string };

interface Env {
  path: typeof win32;
  windows: boolean;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  pathEnv: string;
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

/** Programs the CLI starts by name, with the install hint shown when they are missing. */
const LAUNCHERS: Readonly<Record<string, string>> = { uv: "scoop install uv", go: "scoop install go" };

function inDir(dir: string, command: string): string {
  return dir === "" ? command : `cd ${dir.replace(/\/$/, "")} && ${command}`;
}

/** `dir` and each ancestor directory up to the repo root `root`, nearest first. */
function searchDirs(root: string, dir: string, path: typeof win32): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((_, i) => path.join(root, ...parts.slice(0, parts.length - i))).concat(root);
}

/** Poetry when the nearest Python lockfile is `poetry.lock`; uv otherwise (SPEC §6.1 `deps.manager`). */
function usesPoetry(dirs: readonly string[], env: Env): boolean {
  for (const d of dirs) {
    if (env.exists(env.path.join(d, "uv.lock"))) return false;
    if (env.exists(env.path.join(d, "poetry.lock"))) return true;
  }
  return false;
}

/**
 * The tool in the project's `.venv`. A uv project runs it through `uv run --no-sync`; a Poetry project runs the
 * executable directly, which needs Poetry's environment inside the project (`virtualenvs.in-project`).
 */
function python(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const poetry = usesPoetry(dirs, env);
  const bin = dirs
    .map((d) =>
      env.windows
        ? env.path.join(d, ".venv", "Scripts", `${req.tool}.exe`)
        : env.path.join(d, ".venv", "bin", req.tool),
    )
    .find((p) => env.exists(p));
  if (!bin) {
    const install = poetry ? "poetry config virtualenvs.in-project true && poetry install" : "uv sync";
    return { ok: false, message: `找不到 ${req.tool}：專案環境（.venv）中沒有安裝`, install: inDir(req.dir, install) };
  }
  if (poetry) return { ok: true, command: { file: bin, args: [...(req.args ?? [])], cwd } };
  return { ok: true, command: { file: "uv", args: ["run", "--no-sync", req.tool, ...(req.args ?? [])], cwd } };
}

function typescript(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const name = env.windows ? `${req.tool}.cmd` : req.tool;
  const bin = dirs.map((d) => env.path.join(d, "node_modules", ".bin", name)).find((p) => env.exists(p));
  if (!bin) {
    return { ok: false, message: `找不到 ${req.tool}：node_modules 中沒有安裝`, install: inDir(req.dir, "npm ci") };
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
  const offline = { ...req.env, ...goEnv({ offline: true }) };
  // `go` itself, for module commands such as `go mod tidy -diff`.
  if (req.tool === "go") return { ok: true, command: { file: "go", args: [...args], cwd, env: offline } };
  if (req.tool === "golangci-lint") {
    // Exception in SPEC §5.2: not a go.mod tool, but a binary the developer puts on PATH.
    const exe = onPath(req.tool, env);
    if (!exe) return { ok: false, message: "找不到 golangci-lint", install: pathToolHint("golangci-lint") };
    return { ok: true, command: { file: exe, args: [...args], cwd, env: { ...req.env, ...goEnv() } } };
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

function java(req: ToolRequest, dirs: readonly string[], env: Env): Resolved {
  const cwd = dirs[0] ?? "";
  const wrappers = env.windows ? ["mvnw.cmd", "gradlew.bat"] : ["mvnw", "gradlew"];
  const wrapper = dirs.flatMap((d) => wrappers.map((w) => env.path.join(d, w))).find((w) => env.exists(w));
  if (!wrapper) {
    return {
      ok: false,
      message: `找不到 ${req.tool}：沒有 Maven 或 Gradle wrapper（mvnw / gradlew）`,
      install: inDir(req.dir, "mvn -N wrapper:wrapper"),
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

/** The package manager of a language, pointed at the mirror through its own environment variables. */
function packageManager(req: PackageRequest, cwd: string, env: Env): Resolved {
  const args = [...req.args];
  switch (req.language) {
    case "python":
      return { ok: true, command: { file: "uv", args, cwd, env: { UV_DEFAULT_INDEX: req.mirror } } };
    case "typescript": {
      const npm = onPath("npm", env);
      if (!npm) return { ok: false, message: "找不到 npm", install: "scoop install nodejs-lts" };
      return { ok: true, command: { file: npm, args, cwd, env: { npm_config_registry: req.mirror } } };
    }
    case "go": {
      const env = goEnv({ proxy: req.mirror, ...(req.sumdb ? { sumdb: req.sumdb } : {}) });
      return { ok: true, command: { file: "go", args, cwd, env } };
    }
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
      if (req.mirror.trim() === "") throw new Error("沒有設定內部鏡像，不執行套件管理指令");
      return start(packageManager(req, dirOf(req.dir), env));
    },
  };
}
