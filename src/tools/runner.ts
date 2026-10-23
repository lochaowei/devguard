import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Language } from "../standard/types.ts";
import { nodeExec, type Command, type Exec } from "../process/exec.ts";

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

/** Runs the project's own pinned tools (SPEC §5.2). Never installs or downloads anything. */
export interface ToolRunner {
  /** Throws ToolMissingError when the tool is not installed in the project environment. */
  run(request: ToolRequest): Promise<ToolResult>;
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
  /** PATH, for tools that come from the internal Scoop bucket rather than the project. */
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

/** Programs the CLI starts by name; when missing, they come from the internal Scoop bucket. */
const LAUNCHERS: Readonly<Record<string, string>> = { uv: "scoop install uv", go: "scoop install go" };

function inDir(dir: string, command: string): string {
  return dir === "" ? command : `cd ${dir.replace(/\/$/, "")} && ${command}`;
}

function python(req: ToolRequest, cwd: string, env: Env): Resolved {
  const venv = env.windows
    ? env.path.join(cwd, ".venv", "Scripts", `${req.tool}.exe`)
    : env.path.join(cwd, ".venv", "bin", req.tool);
  if (!env.exists(venv)) {
    return {
      ok: false,
      message: `找不到 ${req.tool}：專案環境（.venv）中沒有安裝`,
      install: inDir(req.dir, "uv sync"),
    };
  }
  return { ok: true, command: { file: "uv", args: ["run", "--no-sync", req.tool, ...(req.args ?? [])], cwd } };
}

function typescript(req: ToolRequest, cwd: string, env: Env): Resolved {
  const bin = env.path.join(cwd, "node_modules", ".bin", env.windows ? `${req.tool}.cmd` : req.tool);
  if (!env.exists(bin)) {
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

/** GOPROXY=off: running a check must never download modules. */
const GO_ENV = { GOTOOLCHAIN: "local", GOPROXY: "off" };

function go(req: ToolRequest, cwd: string, env: Env): Resolved {
  const args = req.args ?? [];
  const goEnv = { ...req.env, ...GO_ENV };
  // `go` itself, for module commands such as `go mod tidy -diff`.
  if (req.tool === "go") return { ok: true, command: { file: "go", args: [...args], cwd, env: goEnv } };
  if (req.tool === "golangci-lint") {
    // Exception in SPEC §5.2: not a go.mod tool, but a binary from the internal Scoop bucket.
    const exe = onPath(req.tool, env);
    if (!exe) return { ok: false, message: "找不到 golangci-lint", install: "scoop install golangci-lint" };
    return { ok: true, command: { file: exe, args: [...args], cwd, env: { ...req.env, GOTOOLCHAIN: "local" } } };
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
  return { ok: true, command: { file: "go", args: ["tool", req.tool, ...args], cwd, env: goEnv } };
}

function java(req: ToolRequest, cwd: string, env: Env): Resolved {
  const wrappers = env.windows ? ["mvnw.cmd", "gradlew.bat"] : ["mvnw", "gradlew"];
  const wrapper = wrappers.map((w) => env.path.join(cwd, w)).find((w) => env.exists(w));
  if (!wrapper) {
    return {
      ok: false,
      message: `找不到 ${req.tool}：沒有 Maven 或 Gradle wrapper（mvnw / gradlew）`,
      install: inDir(req.dir, "mvn -N wrapper:wrapper"),
    };
  }
  return { ok: true, command: { file: wrapper, args: [...(req.args ?? [])], cwd } };
}

const RESOLVERS: Readonly<Record<Language, (req: ToolRequest, cwd: string, env: Env) => Resolved>> = {
  python,
  typescript,
  go,
  java,
};

function isEnoent(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "ENOENT";
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolves each tool to the project's pinned copy (`uv run`, `node_modules/.bin`, `go tool`, wrapper) and runs it. */
export function createToolRunner(deps: ToolRunnerDeps): ToolRunner {
  const windows = (deps.platform ?? process.platform) === "win32";
  const env: Env = {
    path: windows ? win32 : posix,
    windows,
    exists: deps.exists ?? existsSync,
    readText: deps.readText ?? readTextOrUndefined,
    pathEnv: deps.pathEnv ?? process.env.PATH ?? "",
  };
  const exec = deps.exec ?? nodeExec;
  return {
    async run(req) {
      const resolved = RESOLVERS[req.language](req, env.path.join(deps.cwd, req.dir.replace(/\/$/, "")), env);
      if (!resolved.ok) throw new ToolMissingError(resolved.message, resolved.install);
      try {
        return await exec(req.stdin === undefined ? resolved.command : { ...resolved.command, stdin: req.stdin });
      } catch (e) {
        const install = LAUNCHERS[resolved.command.file];
        if (isEnoent(e) && install) throw new ToolMissingError(`找不到 ${resolved.command.file}`, install);
        throw e;
      }
    },
  };
}
