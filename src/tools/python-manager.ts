import { upwards } from "../repo/paths.ts";

/**
 * The package manager a Python component uses, decided from its lockfiles alone (SPEC §6.1 `deps.manager`): the
 * declared `deps.manager` only names the lockfile the deps check requires.
 */
export type PythonManager = "uv" | "poetry";

/** Whether a repo-relative file exists. */
export type FileExists = (file: string) => boolean;

/** The Python lockfiles that decide the manager, repo-relative and nearest first: `<dir>uv.lock`, `<dir>poetry.lock`, … */
export function pythonLockfiles(dir: string): string[] {
  return upwards(dir).flatMap((d) => [`${d}uv.lock`, `${d}poetry.lock`]);
}

/**
 * Poetry when the nearest Python lockfile is `poetry.lock`; uv otherwise. Running tools and `standard upgrade` both
 * decide this way.
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

/** Everything devguard does differently for uv and Poetry. */
export interface PythonManagerDef {
  /** The program, e.g. for `standard upgrade --apply`. */
  program: string;
  /** Adds dev dependencies, followed by PEP 508 requirements such as `ruff>=0.18,<0.19` (SPEC §5.5). */
  addDev: readonly string[];
  /** What must run first for the project environment to be the `.venv` devguard runs tools from; none for uv. */
  inProject?: string;
  /** Installs the project environment into `.venv` (SPEC §5.2). */
  install: string;
  /** Runs `tool`, installed at `bin` in the project's `.venv` (SPEC §5.2). */
  runTool(bin: string, tool: string, args: readonly string[]): { file: string; args: string[] };
}

const POETRY_IN_PROJECT = "poetry config virtualenvs.in-project true";

export const PYTHON_MANAGERS: Readonly<Record<PythonManager, PythonManagerDef>> = {
  uv: {
    program: "uv",
    addDev: ["add", "--dev"],
    install: "uv sync",
    runTool: (_bin, tool, args) => ({ file: "uv", args: ["run", "--no-sync", tool, ...args] }),
  },
  poetry: {
    program: "poetry",
    addDev: ["add", "--group", "dev"],
    // Running the .venv's executables directly needs Poetry's environment inside the project.
    inProject: POETRY_IN_PROJECT,
    install: `${POETRY_IN_PROJECT} && poetry install`,
    runTool: (bin, _tool, args) => ({ file: bin, args: [...args] }),
  },
};
