import type { MirrorChecker } from "../mirrors/common.ts";
import { checkPoetry, POETRY_AUTH_VARIABLES, POETRY_SOURCE_NAME } from "../mirrors/poetry.ts";
import { checkUv, UV_AUTH_VARIABLES } from "../mirrors/uv.ts";
import { upwards } from "../repo/paths.ts";

/**
 * The package manager a Python component uses, decided from its lockfiles alone (SPEC §5.2): `deps.manager` in the
 * declaration only says which managers the standard allows.
 */
export type PythonManager = "uv" | "poetry";

/** Whether a repo-relative file exists. */
export type FileExists = (file: string) => boolean;

/** The Python lockfiles that decide the manager, repo-relative and nearest first: `<dir>uv.lock`, `<dir>poetry.lock`, … */
export function pythonLockfiles(dir: string): string[] {
  return upwards(dir).flatMap((d) => [`${d}uv.lock`, `${d}poetry.lock`]);
}

/**
 * Poetry when the nearest Python lockfile is `poetry.lock`; uv otherwise. Running tools, the mirror check, mirror
 * credentials and `standard upgrade` all decide this way.
 */
export function pythonManager(dir: string, exists: FileExists): PythonManager {
  const nearest = pythonLockfiles(dir).find(exists);
  return nearest?.endsWith("poetry.lock") ? "poetry" : "uv";
}

/** `pythonManager` through an async reader of repo-relative files (undefined when a file does not exist). */
export async function readPythonManager(
  dir: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<PythonManager> {
  const present = new Set<string>();
  for (const file of pythonLockfiles(dir)) if ((await read(file)) !== undefined) present.add(file);
  return pythonManager(dir, (file) => present.has(file));
}

/** Where a Python manager downloads packages from. */
export type PythonMirror =
  /** `mirrors.pypi`, handed to it through environment variables. */
  | { from: "env"; env: (mirror: string) => Readonly<Record<string, string>> }
  /** The project's own settings, which the mirror check keeps on `mirrors.pypi`; `where` names them. */
  | { from: "project"; where: (dir: string) => string };

/** Everything devguard does differently for uv and Poetry. */
export interface PythonManagerDef {
  /** The program, e.g. for `standard upgrade --apply`. */
  program: string;
  /** Adds dev dependencies, followed by PEP 508 requirements such as `ruff>=0.18,<0.19` (SPEC §5.5). */
  addDev: readonly string[];
  mirror: PythonMirror;
  /** The project-level mirror check (SPEC §10.2). */
  checkMirror: MirrorChecker;
  /** The variables it reads mirror credentials from, and what they are for (SPEC §10.3). */
  auth: { variables: readonly string[]; purpose: string };
  /** Installs the project environment into `.venv` (SPEC §5.2). */
  install: string;
  /** Runs `tool`, installed at `bin` in the project's `.venv` (SPEC §5.2). */
  runTool(bin: string, tool: string, args: readonly string[]): { file: string; args: string[] };
}

export const PYTHON_MANAGERS: Readonly<Record<PythonManager, PythonManagerDef>> = {
  uv: {
    program: "uv",
    addDev: ["add", "--dev"],
    mirror: { from: "env", env: (mirror) => ({ UV_DEFAULT_INDEX: mirror }) },
    checkMirror: checkUv,
    auth: { variables: UV_AUTH_VARIABLES, purpose: "uv 登入 nexus index" },
    install: "uv sync",
    runTool: (_bin, tool, args) => ({ file: "uv", args: ["run", "--no-sync", tool, ...args] }),
  },
  poetry: {
    program: "poetry",
    addDev: ["add", "--group", "dev"],
    mirror: { from: "project", where: (dir) => `${dir}pyproject.toml 的 [[tool.poetry.source]] ${POETRY_SOURCE_NAME}` },
    checkMirror: checkPoetry,
    auth: { variables: POETRY_AUTH_VARIABLES, purpose: "Poetry 登入 nexus source" },
    // Running the .venv's executables directly needs Poetry's environment inside the project.
    install: "poetry config virtualenvs.in-project true && poetry install",
    runTool: (bin, _tool, args) => ({ file: bin, args: [...args] }),
  },
};
